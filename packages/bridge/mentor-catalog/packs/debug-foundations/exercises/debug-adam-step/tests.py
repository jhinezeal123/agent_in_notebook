def _problem(seed=0):
    rng = np.random.default_rng(seed)
    params = {"w": rng.normal(size=(3, 2)), "b": rng.normal(size=2)}
    target = {"w": rng.normal(size=(3, 2)), "b": rng.normal(size=2)}
    grad = lambda p: {k: 2 * (p[k] - target[k]) + 0.1 * np.sin(p[k]) for k in p}
    return params, grad


def _run(init, step, steps, **kw):
    params, grad = _problem()
    params = {k: v.copy() for k, v in params.items()}
    state = init(params)
    history = []
    for _ in range(steps):
        res = step(params, grad(params), state, **kw)
        assert isinstance(res, tuple) and len(res) == 2, "adam_step phải trả về (new_params, new_state)."
        params, state = res
        history.append({k: np.array(v, dtype=float) for k, v in params.items()})
    return history


def test_first_step_size(user, ref):
    """Bước đầu tiên dịch mỗi tham số khoảng lr"""
    init, step = need(user, "adam_init"), need(user, "adam_step")
    params, grad = _problem()
    before = {k: v.copy() for k, v in params.items()}
    new, _ = step({k: v.copy() for k, v in params.items()}, grad(params), init(params), lr=0.01)
    moved = np.concatenate([np.abs(np.asarray(new[k], float) - before[k]).ravel() for k in before])
    assert np.allclose(moved, 0.01, rtol=1e-3), f"Bước đầu dịch {moved.min():.4f}…{moved.max():.4f}, cần ≈ 0.01: kiểm hiệu chỉnh bias."


def test_matches_reference(user, ref):
    """Khớp Adam chuẩn sau 1, 2 và 20 bước"""
    got = _run(need(user, "adam_init"), need(user, "adam_step"), 20, lr=0.05)
    want = _run(ref["adam_init"], ref["adam_step"], 20, lr=0.05)
    for i in [0, 1, 19]:
        for k in want[i]:
            assert np.allclose(got[i][k], want[i][k], atol=1e-9), f"Sau bước {i + 1}, tham số {k} lệch Adam chuẩn."


def test_hyperparameters(user, ref):
    """Tôn trọng b1, b2, eps"""
    kw = dict(lr=0.02, b1=0.5, b2=0.9, eps=1e-3)
    got = _run(need(user, "adam_init"), need(user, "adam_step"), 5, **kw)
    want = _run(ref["adam_init"], ref["adam_step"], 5, **kw)
    for k in want[-1]:
        assert np.allclose(got[-1][k], want[-1][k], atol=1e-9), "Sai khi đổi b1, b2, eps."


def test_zero_gradient(user, ref):
    """Gradient bằng 0 từ đầu thì tham số đứng yên"""
    init, step = need(user, "adam_init"), need(user, "adam_step")
    params = {"w": np.ones(3)}
    new, _ = step({"w": np.ones(3)}, {"w": np.zeros(3)}, init(params))
    assert np.allclose(np.asarray(new["w"], float), 1.0), "Gradient 0 vẫn làm tham số đổi."
