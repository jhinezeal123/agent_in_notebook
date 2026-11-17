N_EPISODES = 20
SEED_EVAL = 10_000


def _q_net(user):
    q = user.get("q_net")
    assert isinstance(q, nn.Module), "Chưa thấy biến toàn cục `q_net` (một nn.Module): chạy cell train và để mạng Q đã train trong biến tên `q_net`."
    return q


def _q_values(q, obs):
    """Q-value (n_actions,) của một trạng thái, đo ở chế độ eval, không gradient, mạng ở thiết bị nào cũng được."""
    device = next(q.parameters()).device
    was_training = q.training
    q.eval()
    try:
        with torch.no_grad():
            return q(torch.as_tensor(obs, dtype=torch.float32, device=device).unsqueeze(0))[0].cpu()
    finally:
        q.train(was_training)


def _greedy(q):
    return lambda obs: int(_q_values(q, obs).argmax())


def _episode_returns(ref, policy):
    return [ref["evaluate"](policy, 1, seed=SEED_EVAL + i) for i in range(N_EPISODES)]


def test_q_net_defined(user, ref):
    """Có biến q_net (nn.Module) nhận trạng thái (B, 4) và trả Q-value (B, 2)"""
    q = _q_net(user)
    device = next(q.parameters()).device
    was_training = q.training
    q.eval()
    try:
        with torch.no_grad():
            out = q(torch.zeros(3, ref["OBS_DIM"], device=device))
    finally:
        q.train(was_training)
    t.shape(out, (3, ref["N_ACTIONS"]), what="Q-value của q_net với trạng thái shape (3, 4)")


def test_weights_finite(user, ref):
    """Mọi tham số của q_net hữu hạn: quá trình train không phát nổ thành NaN hoặc inf"""
    bad = [n for n, p in _q_net(user).named_parameters() if not bool(torch.isfinite(p).all())]
    assert not bad, f"q_net có NaN hoặc inf ở {bad[:3]}: train bị phát nổ (learning rate bao nhiêu, mạng target có được cập nhật định kỳ không?)."


def test_greedy_return(user, ref):
    """Đo mean_return: chạy chính sách tham lam của q_net trên 20 episode CartPole mới (seed cố định, mô hình chưa từng thấy), chỉ đo, không train"""
    returns = _episode_returns(ref, _greedy(_q_net(user)))
    mean_return = float(np.mean(returns))
    t.report("mean_return", mean_return)
    t.report("solved_frac", float(np.mean([r >= ref["MAX_STEPS"] for r in returns])))
    assert np.isfinite(mean_return), "Return đo được không hữu hạn."


def test_beats_random(user, ref):
    """Đo random_return (chính sách ngẫu nhiên, cùng 20 episode) và đòi chính sách của q_net hơn hẳn nó (gấp đôi trở lên)"""
    q = _q_net(user)
    rng = np.random.default_rng(0)
    random_return = float(np.mean(_episode_returns(ref, lambda obs: int(rng.integers(ref["N_ACTIONS"])))))
    learned = float(np.mean(_episode_returns(ref, _greedy(q))))
    t.report("random_return", random_return)
    assert learned > 2 * random_return, f"Chính sách tham lam của q_net đạt {learned:.1f}, chưa hơn gấp đôi chính sách ngẫu nhiên ({random_return:.1f}). Mạng đã được train chưa, và có phải bạn đo trên mạng khởi tạo, mạng target cũ, hay mạng chưa được chép lại?"


def test_q_values_sane(user, ref):
    """Đo q_start: Q lớn nhất trung bình ở 20 trạng thái đầu episode; hữu hạn và không phát nổ (nhỏ hơn 500, trong khi giá trị thật không quá 1 / (1 − γ))"""
    q = _q_net(user)
    env = ref["CartPole"]()
    starts = [_q_values(q, env.reset(seed=SEED_EVAL + i)).max().item() for i in range(20)]
    q_start = float(np.mean(starts))
    t.report("q_start", q_start)
    assert np.isfinite(q_start), "Q-value ở trạng thái đầu không hữu hạn."
    assert q_start < 500, f"Q lớn nhất trung bình ở trạng thái đầu là {q_start:.0f}: quá lớn so với tổng thưởng có thể có (tối đa 200 bước, mỗi bước thưởng 1). Mạng đang phân kỳ hoặc đánh giá quá cao: xem lại mạng target và learning rate."
