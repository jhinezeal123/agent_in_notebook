import warnings


def _qkv(B=2, T=4, S=5, d=8, dv=3, seed=0, scale=1.0):
    rng = np.random.default_rng(seed)
    return rng.normal(size=(B, T, d)) * scale, rng.normal(size=(B, S, d)) * scale, rng.normal(size=(B, S, dv))


def _call(f, *args, **kw):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        res = f(*args, **kw)
    assert isinstance(res, tuple) and len(res) == 2, "Hàm phải trả về một tuple (out, weights)."
    return np.asarray(res[0], float), np.asarray(res[1], float)


def test_tau_one(user, ref):
    """τ = 1 cho đúng attention của bài trước (shape và giá trị)"""
    f = need(user, "attention_temp")
    args = _qkv(seed=1, d=16)
    out, w = _call(f, *args, tau=1.0)
    assert out.shape == (2, 4, 3) and w.shape == (2, 4, 5), f"Shape out {out.shape}, weights {w.shape}; cần (2, 4, 3) và (2, 4, 5)."
    want_out, want_w = ref["attention_temp"](*args, tau=1.0)
    assert np.allclose(w, want_w, atol=1e-8) and np.allclose(out, want_out, atol=1e-8), "Với τ = 1 phải ra đúng softmax(QKᵀ/√d_k) V."


def test_values_tau(user, ref):
    """Đúng giá trị với τ = 0.5 và τ = 3"""
    f = need(user, "attention_temp")
    args = _qkv(seed=2, d=16)
    for tau in (0.5, 3.0):
        out, w = _call(f, *args, tau=tau)
        want_out, want_w = ref["attention_temp"](*args, tau=tau)
        assert np.allclose(w, want_w, atol=1e-8), f"weights sai với τ = {tau}: điểm phải chia cho τ·√d_k (τ ở mẫu số, không lấy căn τ)."
        assert np.allclose(out, want_out, atol=1e-8), f"out sai với τ = {tau}."


def test_causal_mask(user, ref):
    """Mask nhân quả với τ = 0.3: không nhìn tương lai, hàng cộng thành 1"""
    f = need(user, "attention_temp")
    Q, K, V = _qkv(T=5, S=5, seed=3)
    mask = np.tril(np.ones((5, 5), dtype=bool))
    out, w = _call(f, Q, K, V, tau=0.3, mask=mask)
    assert np.allclose(w[:, ~mask], 0, atol=1e-12), "Vị trí bị che vẫn có trọng số khác 0: che bằng −∞ trước softmax."
    assert np.allclose(w.sum(-1), 1), "Sau khi che, hàng chưa cộng thành 1."
    want_out, _ = ref["attention_temp"](Q, K, V, tau=0.3, mask=mask)
    assert np.allclose(out, want_out, atol=1e-8), "out với mask chưa đúng."


def test_cold_limit(user, ref):
    """τ rất nhỏ (1e-4): hữu hạn và gần one-hot tại điểm lớn nhất trong vùng được nhìn"""
    f = need(user, "attention_temp")
    Q, K, V = _qkv(T=6, S=6, seed=4, d=16)
    mask = np.tril(np.ones((6, 6), dtype=bool))
    out, w = _call(f, Q, K, V, tau=1e-4, mask=mask)
    assert np.isfinite(w).all() and np.isfinite(out).all(), "Có nan/inf khi τ nhỏ: điểm bị nhân lên rất lớn, softmax cần trừ max."
    scores = np.where(mask, Q @ np.swapaxes(K, -1, -2), -np.inf)
    hot = np.eye(6)[scores.argmax(-1)]
    assert np.allclose(w, hot, atol=1e-6), "Khi τ → 0, mỗi hàng phải gần one-hot tại vị trí có điểm lớn nhất (trong vùng được nhìn)."
    assert np.allclose(w, ref["attention_temp"](Q, K, V, tau=1e-4, mask=mask)[1], atol=1e-8), "weights chưa đúng khi τ nhỏ."


def test_hot_limit(user, ref):
    """τ rất lớn (1e6): đều trên các vị trí được nhìn, vị trí bị che vẫn bằng 0"""
    f = need(user, "attention_temp")
    Q, K, V = _qkv(T=5, S=5, seed=5, scale=3.0)
    mask = np.tril(np.ones((5, 5), dtype=bool))
    out, w = _call(f, Q, K, V, tau=1e6, mask=mask)
    uniform = mask / mask.sum(-1, keepdims=True)
    assert np.isfinite(w).all(), "Có nan/inf khi τ lớn."
    assert np.allclose(w, uniform, atol=1e-4), "Khi τ → ∞, hàng t phải gần đều 1/(t+1) trên các vị trí được nhìn và đúng 0 ở vị trí bị che."
    assert np.allclose(out, ref["attention_temp"](Q, K, V, tau=1e6, mask=mask)[0], atol=1e-8), "out chưa đúng khi τ lớn."


def test_heads(user, ref):
    """Chạy với nhiều trục batch/head (B, H, T, d) và τ = 0.7"""
    f = need(user, "attention_temp")
    rng = np.random.default_rng(6)
    Q, K, V = rng.normal(size=(2, 3, 4, 8)), rng.normal(size=(2, 3, 6, 8)), rng.normal(size=(2, 3, 6, 5))
    out, w = _call(f, Q, K, V, tau=0.7)
    assert out.shape == (2, 3, 4, 5) and w.shape == (2, 3, 4, 6), f"Shape out {out.shape}, weights {w.shape}."
    assert np.allclose(out, ref["attention_temp"](Q, K, V, tau=0.7)[0], atol=1e-8), "Sai với tensor 4 chiều (τ = 0.7): chuyển vị hai trục cuối của K, chia điểm cho τ·√d_k."
