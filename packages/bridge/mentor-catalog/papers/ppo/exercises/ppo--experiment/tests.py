N_EPISODES = 20
SEED_EVAL = 10_000


def _policy(user):
    p = user.get("policy")
    assert isinstance(p, nn.Module), "Chưa thấy biến toàn cục `policy` (một nn.Module): chạy cell train và để mạng actor-critic đã train trong biến tên `policy`."
    return p


def _forward(policy, obs):
    """(logits, value) của policy cho một batch trạng thái, đo ở chế độ eval, không gradient."""
    device = next(policy.parameters()).device
    was_training = policy.training
    policy.eval()
    try:
        with torch.no_grad():
            logits, value = policy(torch.as_tensor(obs, dtype=torch.float32, device=device))
        return logits.cpu(), value.cpu()
    finally:
        policy.train(was_training)


def _sampler(policy, entropies, seed=0):
    gen = torch.Generator().manual_seed(seed)

    def act(obs):
        logits, _ = _forward(policy, np.asarray(obs, dtype=np.float32)[None])
        log_probs = F.log_softmax(logits[0], dim=-1)
        entropies.append(float(-(log_probs.exp() * log_probs).sum()))
        return int(torch.multinomial(log_probs.exp(), 1, generator=gen))

    return act


def _greedy(policy):
    return lambda obs: int(_forward(policy, np.asarray(obs, dtype=np.float32)[None])[0][0].argmax())


def _episode_returns(ref, policy_fn):
    return [ref["evaluate"](policy_fn, 1, seed=SEED_EVAL + i) for i in range(N_EPISODES)]


def test_policy_defined(user, ref):
    """Có biến policy (nn.Module) nhận trạng thái (B, 4) và trả (logits (B, 2), value (B,))"""
    out = _forward(_policy(user), torch.zeros(3, ref["OBS_DIM"]))
    assert isinstance(out, tuple) and len(out) == 2, "policy(obs) phải trả về cặp (logits, value)."
    t.shape(out[0], (3, ref["N_ACTIONS"]), what="logits của policy với trạng thái shape (3, 4)")
    t.shape(out[1], (3,), what="value của policy với trạng thái shape (3, 4)")


def test_weights_finite(user, ref):
    """Mọi tham số của policy hữu hạn: quá trình train không phát nổ thành NaN hoặc inf"""
    bad = [n for n, p in _policy(user).named_parameters() if not bool(torch.isfinite(p).all())]
    assert not bad, f"policy có NaN hoặc inf ở {bad[:3]}: train bị phát nổ (learning rate bao nhiêu, advantage đã chuẩn hóa chưa, gradient có bị cắt không?)."


def test_sampled_return(user, ref):
    """Đo mean_return: chạy policy (lấy mẫu hành động như lúc train) trên 20 episode CartPole mới, seed cố định, chỉ đo, không train; kèm greedy_return và policy_entropy"""
    policy = _policy(user)
    entropies = []
    returns = _episode_returns(ref, _sampler(policy, entropies))
    mean_return = float(np.mean(returns))
    t.report("mean_return", mean_return)
    t.report("greedy_return", float(np.mean(_episode_returns(ref, _greedy(policy)))))
    entropy = float(np.mean(entropies))
    t.report("policy_entropy", entropy)
    assert np.isfinite(mean_return) and np.isfinite(entropy), "Return hoặc entropy đo được không hữu hạn."
    assert -1e-6 <= entropy <= float(np.log(ref["N_ACTIONS"])) + 1e-6, f"Entropy trung bình {entropy:.3f} nằm ngoài [0, ln 2]: logits của policy có đúng là điểm số chưa chuẩn hóa của hai hành động không?"


def test_beats_random(user, ref):
    """Đo random_return (chính sách ngẫu nhiên, cùng 20 episode) và đòi policy hơn hẳn nó (gấp đôi trở lên)"""
    rng = np.random.default_rng(0)
    random_return = float(np.mean(_episode_returns(ref, lambda obs: int(rng.integers(ref["N_ACTIONS"])))))
    learned = float(np.mean(_episode_returns(ref, _sampler(_policy(user), []))))
    t.report("random_return", random_return)
    assert learned > 2 * random_return, f"Policy đạt {learned:.1f}, chưa hơn gấp đôi chính sách ngẫu nhiên ({random_return:.1f}). Policy đã được train chưa: ppo_update có được gọi sau mỗi rollout, advantage có tín hiệu, và có phải bạn đo trên policy khởi tạo?"


def test_value_head(user, ref):
    """Đo value_start: V trung bình ở 20 trạng thái đầu episode; hữu hạn và không phát nổ (nhỏ hơn 500 khi tổng thưởng tối đa là 200)"""
    policy = _policy(user)
    env = ref["CartPole"]()
    starts = np.array([env.reset(seed=SEED_EVAL + i) for i in range(20)], dtype=np.float32)
    value_start = float(_forward(policy, starts)[1].mean())
    t.report("value_start", value_start)
    assert np.isfinite(value_start), "V ở trạng thái đầu không hữu hạn."
    assert value_start < 500, f"V trung bình ở trạng thái đầu là {value_start:.0f}: quá lớn so với tổng thưởng có thể có (tối đa 200 bước, mỗi bước thưởng 1). Critic đang phát nổ: xem lại learning rate, vf_coef và returns."
