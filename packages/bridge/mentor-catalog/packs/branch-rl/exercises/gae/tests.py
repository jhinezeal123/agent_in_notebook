def _rollout(seed=0, T=8, p_done=0.2):
    g = torch.Generator().manual_seed(seed)
    rewards = torch.randn(T, generator=g)
    values = torch.randn(T, generator=g)
    dones = (torch.rand(T, generator=g) < p_done).to(torch.float32)
    last_value = float(torch.randn((), generator=g))
    return rewards, values, dones, last_value


def _np(x):
    return np.asarray(x.detach().numpy() if hasattr(x, "detach") else x, dtype=np.float64)


def _td0(rewards, values, dones, last_value, gamma):
    r, v, d = _np(rewards), _np(values), _np(dones)
    nxt = np.append(v[1:], float(last_value))
    return r + gamma * (1.0 - d) * nxt - v


def _mc_returns(rewards, dones, last_value, gamma):
    r, d = _np(rewards), _np(dones)
    out = np.zeros(len(r))
    run = float(last_value)
    for i in range(len(r) - 1, -1, -1):
        run = r[i] + gamma * (1.0 - d[i]) * run
        out[i] = run
    return out


def test_hand_example(user, ref):
    """Ví dụ tính tay (gamma = lambda = 0.5, ba bước, một episode): sai số TD rồi cộng dồn ngược, returns = A + V"""
    f = need(user, "compute_gae")
    rewards = torch.tensor([1.0, 1.0, 1.0])
    values = torch.tensor([1.0, 2.0, 3.0])
    dones = torch.zeros(3)
    adv, ret = f(rewards, values, dones, 4.0, 0.5, 0.5)
    assert np.allclose(_np(adv), [1.125, 0.5, 0.0], atol=1e-5), (
        f"r = [1, 1, 1], V = [1, 2, 3], last_value = 4, gamma = lambda = 0.5: delta = [1, 0.5, 0] (bước cuối bootstrap bằng last_value = 4: 1 + 0.5 * 4 - 3 = 0); "
        f"A = [1 + 0.25 * 0.5, 0.5 + 0.25 * 0, 0] = [1.125, 0.5, 0]. Bạn ra A = {np.round(_np(adv), 4).tolist()}."
    )
    assert np.allclose(_np(ret), [2.125, 2.5, 3.0], atol=1e-5), f"returns = A + V = [2.125, 2.5, 3]; bạn ra {np.round(_np(ret), 4).tolist()}."


def test_done_blocks_bootstrap_and_trace(user, ref):
    """Cờ done chặn cả V ở bước sau lẫn phần cộng dồn A ở bước sau: không có gì lọt qua ranh giới episode"""
    f = need(user, "compute_gae")
    rewards = torch.tensor([1.0, 2.0, 3.0, 4.0])
    values = torch.tensor([0.5, 1.0, 2.0, 3.0])
    dones = torch.tensor([0.0, 1.0, 0.0, 0.0])
    adv, _ = f(rewards, values, dones, 5.0, 0.9, 0.95)
    assert abs(float(adv[1]) - (2.0 - 1.0)) < 1e-5, (
        f"Bước 1 là bước cuối của episode (done = 1): không còn tương lai, A_1 = r_1 - V_1 = 1.0; bạn ra {float(adv[1]):.4f}. "
        f"Bạn đã chặn V ở bước sau chưa, và chặn phần A ở bước sau chưa?"
    )
    assert abs(float(adv[0]) - (1.0 + 0.9 * 1.0 - 0.5 + 0.9 * 0.95 * 1.0)) < 1e-5, (
        f"Bước 0: delta_0 = 1 + 0.9 * V_1 - V_0 = 1.4, cộng 0.9 * 0.95 * A_1 = 0.855: A_0 = 2.255. Bạn ra {float(adv[0]):.4f}. "
        f"(A_1 nằm cùng episode với bước 0 nên vẫn được cộng vào A_0.)"
    )
    rewards2 = rewards.clone()
    values2 = values.clone()
    rewards2[2:] = torch.tensor([30.0, -40.0])
    values2[2:] = torch.tensor([-7.0, 9.0])
    adv2, _ = f(rewards2, values2, dones, -11.0, 0.9, 0.95)
    assert np.allclose(_np(adv2)[:2], _np(adv)[:2], atol=1e-5), (
        "Đổi thưởng, giá trị và last_value của episode SAU làm đổi advantage của episode TRƯỚC: thông tin đã lọt qua ranh giới. "
        "Kiểm tra cả hai chỗ dùng cờ done."
    )


def test_last_value_bootstraps_rollout_end(user, ref):
    """Cuối rollout chưa kết thúc episode thì bootstrap bằng last_value; nếu bước cuối là done thì last_value không có tác dụng"""
    f = need(user, "compute_gae")
    rewards = torch.tensor([1.0, 0.0, 2.0])
    values = torch.tensor([0.0, 1.0, 1.0])
    d0 = torch.zeros(3)
    a1, _ = f(rewards, values, d0, 0.0, 0.9, 0.9)
    a2, _ = f(rewards, values, d0, 10.0, 0.9, 0.9)
    assert abs(float(a2[2]) - float(a1[2]) - 0.9 * 10.0) < 1e-4, (
        f"last_value tăng 10 thì delta của bước cuối phải tăng gamma * 10 = 9 (A_2 = delta_2); A_2 đổi từ {float(a1[2]):.3f} sang {float(a2[2]):.3f}."
    )
    a3, r3 = f(rewards, values, d0, torch.tensor(10.0), 0.9, 0.9)
    t.close(a3, a2, tol=1e-5, what="advantages khi last_value là tensor 0 chiều")
    d1 = torch.tensor([0.0, 0.0, 1.0])
    b1, _ = f(rewards, values, d1, 0.0, 0.9, 0.9)
    b2, _ = f(rewards, values, d1, 10.0, 0.9, 0.9)
    assert np.allclose(_np(b1), _np(b2)), "Bước cuối là done (episode thật sự kết thúc) nhưng last_value vẫn ảnh hưởng kết quả: không bootstrap qua done."
    assert abs(float(b1[2]) - (2.0 - 1.0)) < 1e-5, f"Bước cuối done: A_2 = r_2 - V_2 = 1.0; bạn ra {float(b1[2]):.4f}."


def test_lambda_zero_is_td0(user, ref):
    """lambda = 0: advantage chỉ còn sai số TD một bước"""
    f = need(user, "compute_gae")
    for seed in range(3):
        rewards, values, dones, last = _rollout(seed, T=9)
        adv, _ = f(rewards, values, dones, last, 0.97, 0.0)
        want = _td0(rewards, values, dones, last, 0.97)
        assert np.allclose(_np(adv), want, atol=1e-5), (
            f"lambda = 0: A_t = delta_t = r_t + gamma * (1 - d_t) * V_(t+1) - V_t (V_T = last_value). Lệch lớn nhất {np.abs(_np(adv) - want).max():.2e} (seed {seed})."
        )


def test_lambda_one_is_monte_carlo(user, ref):
    """lambda = 1: advantage là return Monte-Carlo (bootstrap bằng last_value ở cuối rollout) trừ V"""
    f = need(user, "compute_gae")
    for seed in range(3):
        rewards, values, dones, last = _rollout(seed + 10, T=9)
        for gamma in (1.0, 0.95):
            adv, ret = f(rewards, values, dones, last, gamma, 1.0)
            want_ret = _mc_returns(rewards, dones, last, gamma)
            assert np.allclose(_np(ret), want_ret, atol=1e-4), (
                f"lambda = 1: returns phải là tổng thưởng chiết khấu tới hết episode (cuối rollout thì cộng gamma^k * last_value); "
                f"lệch lớn nhất {np.abs(_np(ret) - want_ret).max():.2e} (gamma {gamma}, seed {seed})."
            )
            assert np.allclose(_np(adv), want_ret - _np(values), atol=1e-4), f"lambda = 1: A_t = G_t - V_t. Lệch (gamma {gamma}, seed {seed})."


def test_matches_reference(user, ref):
    """Nhiều rollout, gamma và lambda khác nhau (kể cả T = 1, nhiều episode trong một rollout): khớp lời giải chuẩn"""
    f = need(user, "compute_gae")
    cases = [(0, 8, 0.99, 0.95), (1, 1, 0.9, 0.5), (2, 20, 0.99, 0.9), (3, 6, 0.5, 0.3), (4, 15, 1.0, 0.95), (5, 12, 0.8, 1.0)]
    for seed, T, gamma, lam in cases:
        rewards, values, dones, last = _rollout(seed, T, p_done=0.25)
        got_a, got_r = f(rewards, values, dones, last, gamma, lam)
        want_a, want_r = ref["compute_gae"](rewards, values, dones, last, gamma, lam)
        t.shape(got_a, (T,), what="advantages")
        t.shape(got_r, (T,), what="returns")
        t.close(got_a, want_a, tol=1e-5, what=f"advantages (T={T}, gamma={gamma}, lambda={lam})")
        t.close(got_r, want_r, tol=1e-5, what=f"returns (T={T}, gamma={gamma}, lambda={lam})")


def test_returns_equal_advantages_plus_values(user, ref):
    """returns = advantages + values, đúng mục tiêu cho mạng giá trị"""
    f = need(user, "compute_gae")
    rewards, values, dones, last = _rollout(21, T=10)
    adv, ret = f(rewards, values, dones, last, 0.99, 0.95)
    t.close(ret, adv + values, tol=1e-5, what="returns so với advantages + values")
    assert not np.allclose(_np(ret), _np(adv)), "returns trùng advantages: returns = A + V, không phải chỉ A."


def test_no_gradient_dtype_and_inputs_untouched(user, ref):
    """Kết quả là float32 (T,) không dính đồ thị gradient dù values đang có gradient; không sửa đầu vào"""
    f = need(user, "compute_gae")
    rewards, values, dones, last = _rollout(22, T=7)
    v = values.clone().requires_grad_(True)
    saved = [rewards.clone(), values.clone(), dones.clone()]
    adv, ret = f(rewards, v, dones, last, 0.99, 0.95)
    for name, x in (("advantages", adv), ("returns", ret)):
        assert isinstance(x, torch.Tensor) and tuple(x.shape) == (7,), f"{name} phải là tensor shape (7,)."
        assert x.dtype == torch.float32, f"{name} có dtype {x.dtype}, cần float32."
        assert not x.requires_grad, f"{name} đang dính đồ thị gradient của values: critic phải được tách ra (detach) khi tính tín hiệu học."
    for name, before, after in zip(["rewards", "values", "dones"], saved, [rewards, v.detach(), dones]):
        assert torch.equal(before, after), f"{name} bị sửa tại chỗ."
