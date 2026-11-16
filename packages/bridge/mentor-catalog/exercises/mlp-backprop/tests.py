def _setup(B=4, D=3, H=5, O=2, seed=0):
    rng = np.random.default_rng(seed)
    params = {"W1": rng.normal(size=(D, H)), "b1": rng.normal(size=H) * 0.1, "W2": rng.normal(size=(H, O)), "b2": rng.normal(size=O) * 0.1}
    return rng.normal(size=(B, D)), params, rng.normal(size=(B, O))


def _forward(user, X, params):
    res = need(user, "mlp_forward")(X, params)
    assert isinstance(res, tuple) and len(res) == 2, "mlp_forward phải trả về (out, cache)."
    return np.asarray(res[0], float), res[1]


def test_forward(user, ref):
    """Forward đúng shape và giá trị"""
    X, params, _ = _setup()
    out, _ = _forward(user, X, params)
    want, _ = ref["mlp_forward"](X, params)
    assert out.shape == want.shape, f"out có shape {out.shape}, cần {want.shape}."
    assert np.allclose(out, want), "Giá trị forward chưa đúng."


def test_grad_shapes(user, ref):
    """Mỗi gradient cùng shape với tham số"""
    X, params, G = _setup(seed=1)
    _, cache = _forward(user, X, params)
    grads = need(user, "mlp_backward")(G, cache, params)
    for k, p in params.items():
        assert k in grads, f"Thiếu gradient {k}."
        assert np.shape(grads[k]) == p.shape, f"Gradient {k} có shape {np.shape(grads[k])}, cần {p.shape}."


def test_grad_values(user, ref):
    """Gradient đúng giá trị"""
    X, params, G = _setup(seed=2)
    _, cache = _forward(user, X, params)
    grads = need(user, "mlp_backward")(G, cache, params)
    _, rcache = ref["mlp_forward"](X, params)
    want = ref["mlp_backward"](G, rcache, params)
    for k in ["W2", "b2", "W1", "b1"]:
        assert np.allclose(np.asarray(grads[k], float), want[k], atol=1e-8), f"Gradient {k} chưa đúng."


def test_numeric_gradient(user, ref):
    """Khớp gradient số (sai phân hữu hạn)"""
    X, params, G = _setup(B=3, D=2, H=4, O=2, seed=3)
    _, cache = _forward(user, X, params)
    grads = need(user, "mlp_backward")(G, cache, params)
    eps = 1e-6
    for k, p in params.items():
        flat = p.reshape(-1)
        for i in range(flat.size):
            old = flat[i]
            flat[i] = old + eps
            up = (_forward(user, X, params)[0] * G).sum()
            flat[i] = old - eps
            down = (_forward(user, X, params)[0] * G).sum()
            flat[i] = old
            num = (up - down) / (2 * eps)
            got = np.asarray(grads[k], float).reshape(-1)[i]
            assert abs(num - got) < 1e-4 * max(1.0, abs(num)), f"{k}[{i}]: gradient số {num:.5f}, của bạn {got:.5f}."


def test_batch_of_one(user, ref):
    """Chạy với batch 1"""
    X, params, G = _setup(B=1, seed=4)
    _, cache = _forward(user, X, params)
    grads = need(user, "mlp_backward")(G, cache, params)
    assert np.shape(grads["b1"]) == params["b1"].shape, "Với batch 1, gradient của b1 sai shape."
