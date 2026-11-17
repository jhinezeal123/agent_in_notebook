def _rollout(seed=0, T=8, p_done=0.2):
    g = torch.Generator().manual_seed(seed)
    rewards = torch.randn(T, generator=g)
    values = torch.randn(T, generator=g)
    dones = (torch.rand(T, generator=g) < p_done).to(torch.float32)
    last_value = float(torch.randn((), generator=g))
    return rewards, values, dones, last_value


def _np(x):
    return np.asarray(x.detach().numpy() if hasattr(x, "detach") else x, dtype=np.float64)


def _td_target(rewards, values, dones, last_value, gamma):
    r, v, d = _np(rewards), _np(values), _np(dones)
    nxt = np.append(v[1:], float(last_value))
    return r + gamma * (1.0 - d) * nxt


def _mc_returns(rewards, dones, last_value, gamma):
    r, d = _np(rewards), _np(dones)
    out = np.zeros(len(r))
    run = float(last_value)
    for i in range(len(r) - 1, -1, -1):
        run = r[i] + gamma * (1.0 - d[i]) * run
        out[i] = run
    return out


def _hand():
    return torch.tensor([1.0, 1.0, 1.0]), torch.tensor([1.0, 2.0, 3.0]), torch.zeros(3), 4.0


def test_hand_example(user, ref):
    """Ví dụ tính tay (gamma = 0.5, ba bước): lambda = 0, 0.5 và 1 cho ba bộ mục tiêu khác nhau"""
    f = need(user, "lambda_return")
    rewards, values, dones, last = _hand()
    for lam, want in [(0.0, [2.0, 2.5, 3.0]), (1.0, [2.25, 2.5, 3.0]), (0.5, [2.125, 2.5, 3.0])]:
        got = _np(f(rewards, values, dones, last, 0.5, lam))
        assert np.allclose(got, want, atol=1e-5), (
            f"r = [1, 1, 1], V = [1, 2, 3], last_value = 4, gamma = 0.5, lambda = {lam}: cần G = {want}; bạn ra {np.round(got, 4).tolist()}. "
            f"(lambda = 0: G_t = r_t + gamma * V_(t+1); lambda = 1: G_t = r_t + gamma * G_(t+1).)"
        )


def test_lambda_extremes(user, ref):
    """lambda = 0 là mục tiêu TD một bước, lambda = 1 là return Monte-Carlo có bootstrap ở cuối rollout, trên dữ liệu ngẫu nhiên có done"""
    f = need(user, "lambda_return")
    for seed in range(3):
        rewards, values, dones, last = _rollout(seed, T=9)
        got0 = _np(f(rewards, values, dones, last, 0.97, 0.0))
        want0 = _td_target(rewards, values, dones, last, 0.97)
        assert np.allclose(got0, want0, atol=1e-5), f"lambda = 0: G_t = r_t + gamma * (1 - d_t) * V_(t+1). Lệch lớn nhất {np.abs(got0 - want0).max():.2e} (seed {seed})."
        got1 = _np(f(rewards, values, dones, last, 0.97, 1.0))
        want1 = _mc_returns(rewards, dones, last, 0.97)
        assert np.allclose(got1, want1, atol=1e-4), f"lambda = 1: G_t = r_t + gamma * (1 - d_t) * G_(t+1), bắt đầu từ last_value. Lệch lớn nhất {np.abs(got1 - want1).max():.2e} (seed {seed})."


def test_last_step_does_not_depend_on_lambda(user, ref):
    """Bước cuối rollout chỉ có thể bootstrap bằng last_value: G_(T-1) giống nhau với mọi lambda"""
    f = need(user, "lambda_return")
    rewards, values, dones, last = _rollout(7, T=6, p_done=0.0)
    want = float(rewards[-1]) + 0.9 * last
    for lam in (0.0, 0.3, 0.8, 1.0):
        got = float(f(rewards, values, dones, last, 0.9, lam)[-1])
        assert abs(got - want) < 1e-5, (
            f"Bước cuối (không done): V_T và G_T đều là last_value nên mọi lambda đều cho G = r + gamma * last_value = {want:.4f}; "
            f"với lambda = {lam} bạn ra {got:.4f}. Bạn khởi tạo 'return của bước sau' bằng gì?"
        )


def test_done_blocks_both_terms(user, ref):
    """Cờ done chặn cả V ở bước sau lẫn return ở bước sau: G ở bước done chỉ là thưởng, và episode sau không làm đổi episode trước"""
    f = need(user, "lambda_return")
    rewards = torch.tensor([1.0, 2.0, 3.0, 4.0])
    values = torch.tensor([0.5, 1.0, 2.0, 3.0])
    dones = torch.tensor([0.0, 1.0, 0.0, 0.0])
    for lam in (0.0, 0.5, 1.0):
        g = _np(f(rewards, values, dones, 5.0, 0.9, lam))
        assert abs(g[1] - 2.0) < 1e-5, f"lambda = {lam}: bước 1 là bước cuối của episode (done = 1), G_1 = r_1 = 2.0; bạn ra {g[1]:.4f}. Cả hai số hạng trong ngoặc vuông đều phải bị chặn."
        rewards2, values2 = rewards.clone(), values.clone()
        rewards2[2:] = torch.tensor([30.0, -40.0])
        values2[2:] = torch.tensor([-7.0, 9.0])
        g2 = _np(f(rewards2, values2, dones, -11.0, 0.9, lam))
        assert np.allclose(g2[:2], g[:2], atol=1e-5), f"lambda = {lam}: đổi episode sau làm đổi G của episode trước: thông tin lọt qua ranh giới."


def test_last_value_ignored_when_final_step_done(user, ref):
    """Bước cuối là done thì last_value không có tác dụng; chưa done thì last_value tác động đúng gamma * last_value"""
    f = need(user, "lambda_return")
    rewards = torch.tensor([1.0, 0.0, 2.0])
    values = torch.tensor([0.0, 1.0, 1.0])
    d1 = torch.tensor([0.0, 0.0, 1.0])
    a, b = _np(f(rewards, values, d1, 0.0, 0.9, 0.9)), _np(f(rewards, values, d1, 10.0, 0.9, 0.9))
    assert np.allclose(a, b), "Bước cuối là done nhưng last_value vẫn ảnh hưởng kết quả: không bootstrap qua done."
    d0 = torch.zeros(3)
    c, d = _np(f(rewards, values, d0, 0.0, 0.9, 0.9)), _np(f(rewards, values, d0, torch.tensor(10.0), 0.9, 0.9))
    assert abs((d[2] - c[2]) - 9.0) < 1e-4, f"last_value tăng 10 thì G của bước cuối tăng gamma * 10 = 9 (last_value có thể là tensor 0 chiều); bạn ra tăng {d[2] - c[2]:.4f}."


def test_equals_returns_of_compute_gae(user, ref):
    """Kết quả bằng đúng returns (= A + V) mà compute_gae của bạn trả về: hai cách tính cùng một đại lượng"""
    f = need(user, "lambda_return")
    gae = need(user, "compute_gae")
    for seed, T, gamma, lam in [(0, 8, 0.99, 0.95), (1, 1, 0.9, 0.5), (2, 16, 0.97, 0.3), (3, 10, 1.0, 0.9), (4, 12, 0.9, 0.0)]:
        rewards, values, dones, last = _rollout(seed, T, p_done=0.25)
        got = f(rewards, values, dones, last, gamma, lam)
        _, want = gae(rewards, values, dones, last, gamma, lam)
        t.close(got, want, tol=1e-4, what=f"lambda_return so với returns của compute_gae (T={T}, gamma={gamma}, lambda={lam})")


def test_exact_values_make_lambda_irrelevant(user, ref):
    """Khi V đã đúng (nhất quán với thưởng thật) thì mọi lambda cho cùng một mục tiêu, và mục tiêu đó chính là V"""
    f = need(user, "lambda_return")
    T, gamma = 6, 0.5
    rewards = torch.ones(T)
    last = 0.0
    v = [0.0] * T
    nxt = last
    for i in range(T - 1, -1, -1):
        v[i] = 1.0 + gamma * nxt
        nxt = v[i]
    values = torch.tensor(v, dtype=torch.float32)
    for lam in (0.0, 0.4, 1.0):
        got = f(rewards, values, torch.zeros(T), last, gamma, lam)
        t.close(got, values, tol=1e-5, what=f"G khi V đã chính xác (lambda = {lam})")


def test_matches_reference(user, ref):
    """Nhiều rollout, gamma và lambda khác nhau (kể cả T = 1): khớp lời giải chuẩn"""
    f = need(user, "lambda_return")
    for seed, T, gamma, lam in [(0, 8, 0.99, 0.95), (1, 1, 0.9, 0.5), (2, 20, 0.99, 0.9), (3, 6, 0.5, 0.3), (4, 15, 1.0, 0.95), (5, 12, 0.8, 1.0)]:
        rewards, values, dones, last = _rollout(seed, T, p_done=0.25)
        got = f(rewards, values, dones, last, gamma, lam)
        want = ref["lambda_return"](rewards, values, dones, last, gamma, lam)
        t.shape(got, (T,), what="lambda-return")
        t.close(got, want, tol=1e-5, what=f"lambda-return (T={T}, gamma={gamma}, lambda={lam})")


def test_no_gradient_dtype_and_inputs_untouched(user, ref):
    """Kết quả là float32 (T,) không dính đồ thị gradient dù values đang có gradient; không sửa đầu vào"""
    f = need(user, "lambda_return")
    rewards, values, dones, last = _rollout(22, T=7)
    v = values.clone().requires_grad_(True)
    saved = [rewards.clone(), values.clone(), dones.clone()]
    got = f(rewards, v, dones, last, 0.99, 0.95)
    assert isinstance(got, torch.Tensor) and tuple(got.shape) == (7,), "lambda_return phải trả về tensor shape (7,)."
    assert got.dtype == torch.float32, f"Kết quả có dtype {got.dtype}, cần float32."
    assert not got.requires_grad, "Kết quả đang dính đồ thị gradient của values: critic phải được tách ra (detach) khi tính mục tiêu."
    for name, before, after in zip(["rewards", "values", "dones"], saved, [rewards, v.detach(), dones]):
        assert torch.equal(before, after), f"{name} bị sửa tại chỗ."
