def _problem(seed=0, gscale=1.0):
    rng = np.random.default_rng(seed)
    params = {"w": rng.normal(size=(3, 2)), "b": rng.normal(size=2)}
    target = {"w": rng.normal(size=(3, 2)), "b": rng.normal(size=2)}
    grad = lambda p: {k: gscale * (2 * (p[k] - target[k]) + 0.1 * np.sin(p[k])) for k in p}
    return params, grad


def _run(init, step, steps, gscale=1.0, **kw):
    params, grad = _problem(gscale=gscale)
    params = {k: v.copy() for k, v in params.items()}
    state = init(params)
    history = []
    for _ in range(steps):
        res = step(params, grad(params), state, **kw)
        assert isinstance(res, tuple) and len(res) == 2, "adamw_step phải trả về (new_params, new_state)."
        params, state = res
        history.append({k: np.array(v, dtype=float) for k, v in params.items()})
    return history


def _same(got, want, steps, msg):
    for i in steps:
        for k in want[i]:
            assert np.allclose(got[i][k], want[i][k], atol=1e-9), msg.format(step=i + 1, name=k)


def test_wd_zero_is_adam(user, ref):
    """wd = 0 thì đúng là Adam"""
    got = _run(need(user, "adamw_init"), need(user, "adamw_step"), 20, lr=0.05, wd=0.0)
    want = _run(ref["adamw_init"], ref["adamw_step"], 20, lr=0.05, wd=0.0)
    _same(got, want, [0, 1, 19], "Với wd = 0, sau bước {step} tham số {name} lệch Adam chuẩn: phần Adam (m, v, hiệu chỉnh bias) chưa đúng.")


def test_matches_reference(user, ref):
    """Khớp AdamW chuẩn sau 1, 2 và 20 bước (wd = 0.1)"""
    got = _run(need(user, "adamw_init"), need(user, "adamw_step"), 20, lr=0.05, wd=0.1)
    want = _run(ref["adamw_init"], ref["adamw_step"], 20, lr=0.05, wd=0.1)
    _same(got, want, [0, 1, 19], "Sau bước {step}, tham số {name} lệch AdamW: decay là lr·wd·θ (θ trước bước), trừ thẳng vào tham số.")


def test_pure_decay(user, ref):
    """Gradient bằng 0: tham số co đúng theo (1 − lr·wd)^t"""
    init, step = need(user, "adamw_init"), need(user, "adamw_step")
    p = {"w": np.array([2.0, -0.5, 1e-3])}
    state = init({"w": p["w"].copy()})
    for _ in range(10):
        p, state = step({"w": np.array(p["w"], float)}, {"w": np.zeros(3)}, state, lr=0.01, wd=0.5)
    want = np.array([2.0, -0.5, 1e-3]) * (1 - 0.01 * 0.5) ** 10
    got = np.asarray(p["w"], float)
    assert np.allclose(got, want, rtol=1e-9, atol=1e-15), f"Ra {got}, cần {want}: decay không được đi qua m, v (không bị chia √v̂) và phải nhân lr."


def test_large_gradients(user, ref):
    """Gradient lớn gấp 1000 lần: decay vẫn giữ nguyên tác dụng"""
    got = _run(need(user, "adamw_init"), need(user, "adamw_step"), 10, gscale=1000.0, lr=0.05, wd=0.2)
    want = _run(ref["adamw_init"], ref["adamw_step"], 10, gscale=1000.0, lr=0.05, wd=0.2)
    _same(got, want, [9], "Sai khi gradient lớn (bước {step}, {name}): decay phải tách khỏi gradient, không bị chia cho √v̂.")


def test_hyperparameters(user, ref):
    """Tôn trọng b1, b2, eps, wd"""
    kw = dict(lr=0.02, b1=0.5, b2=0.9, eps=1e-3, wd=0.3)
    got = _run(need(user, "adamw_init"), need(user, "adamw_step"), 5, **kw)
    want = _run(ref["adamw_init"], ref["adamw_step"], 5, **kw)
    _same(got, want, [4], "Sai khi đổi b1, b2, eps, wd (bước {step}, {name}).")
