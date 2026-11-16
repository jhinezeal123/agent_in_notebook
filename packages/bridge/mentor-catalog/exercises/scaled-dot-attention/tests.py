def _qkv(B=2, T=4, S=5, d=8, dv=3, seed=0, scale=1.0):
    rng = np.random.default_rng(seed)
    return rng.normal(size=(B, T, d)) * scale, rng.normal(size=(B, S, d)) * scale, rng.normal(size=(B, S, dv))


def _call(f, *args, **kw):
    res = f(*args, **kw)
    assert isinstance(res, tuple) and len(res) == 2, "Hàm phải trả về một tuple (out, weights)."
    return np.asarray(res[0], float), np.asarray(res[1], float)


def test_shapes(user, ref):
    """out có shape (..., T, dv), weights có shape (..., T, S)"""
    f = need(user, "attention")
    out, w = _call(f, *_qkv())
    assert out.shape == (2, 4, 3), f"out có shape {out.shape}, cần (2, 4, 3)."
    assert w.shape == (2, 4, 5), f"weights có shape {w.shape}, cần (2, 4, 5)."


def test_rows_sum_to_one(user, ref):
    """Mỗi hàng weights cộng lại bằng 1"""
    f = need(user, "attention")
    _, w = _call(f, *_qkv(seed=1))
    assert np.allclose(w.sum(-1), 1), "Hàng của weights chưa cộng thành 1: softmax theo trục nào?"


def test_values(user, ref):
    """Đúng giá trị (có chia √d_k)"""
    f = need(user, "attention")
    args = _qkv(seed=2, d=16)
    out, w = _call(f, *args)
    want_out, want_w = ref["attention"](*args)
    assert np.allclose(w, want_w, atol=1e-8), "weights chưa đúng: kiểm phép scale."
    assert np.allclose(out, want_out, atol=1e-8), "out chưa đúng."


def test_causal_mask(user, ref):
    """Mask nhân quả: không nhìn tương lai, hàng vẫn cộng thành 1"""
    f = need(user, "attention")
    Q, K, V = _qkv(T=5, S=5, seed=3)
    mask = np.tril(np.ones((5, 5), dtype=bool))
    out, w = _call(f, Q, K, V, mask=mask)
    assert np.allclose(w[:, ~mask], 0, atol=1e-12), "Vị trí bị che vẫn có trọng số khác 0."
    assert np.allclose(w.sum(-1), 1), "Sau khi che, hàng chưa cộng thành 1."
    want_out, _ = ref["attention"](Q, K, V, mask=mask)
    assert np.allclose(out, want_out, atol=1e-8), "out với mask chưa đúng."


def test_heads(user, ref):
    """Chạy với nhiều trục batch/head (B, H, T, d)"""
    f = need(user, "attention")
    rng = np.random.default_rng(4)
    Q, K, V = rng.normal(size=(2, 3, 4, 8)), rng.normal(size=(2, 3, 6, 8)), rng.normal(size=(2, 3, 6, 5))
    out, w = _call(f, Q, K, V)
    assert out.shape == (2, 3, 4, 5) and w.shape == (2, 3, 4, 6), f"Shape out {out.shape}, weights {w.shape}."
    assert np.allclose(out, ref["attention"](Q, K, V)[0], atol=1e-8), "Sai với tensor 4 chiều: chuyển vị trục nào của K?"


def test_stable(user, ref):
    """Điểm rất lớn không ra nan"""
    f = need(user, "attention")
    out, w = _call(f, *_qkv(seed=5, scale=60.0))
    assert np.isfinite(out).all() and np.isfinite(w).all(), "Có nan/inf khi điểm lớn: softmax cần ổn định số."
