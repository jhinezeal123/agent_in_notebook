def _batch(B=3, T=5, V=7, seed=0):
    rng = np.random.default_rng(seed)
    logits = rng.normal(size=(B, T, V))
    log_probs = logits - np.log(np.exp(logits).sum(-1, keepdims=True))
    targets = rng.integers(0, V, size=(B, T))
    lengths = rng.integers(1, T + 1, size=B)
    mask = np.arange(T)[None, :] < lengths[:, None]
    return log_probs, targets, mask


def test_scalar(user, ref):
    """Trả về một số (không phải mảng)"""
    f = need(user, "masked_nll")
    out = f(*_batch())
    assert np.ndim(out) == 0, f"Kết quả có shape {np.shape(out)}, cần là một số."


def test_values(user, ref):
    """Đúng giá trị trên batch ngẫu nhiên"""
    f = need(user, "masked_nll")
    args = _batch(4, 6, 9, seed=1)
    out = float(f(*args))
    want = ref["masked_nll"](*args)
    assert np.isclose(out, want, atol=1e-9), f"Ra {out:.6f}, cần {want:.6f}."


def test_padding_ignored(user, ref):
    """Padding không ảnh hưởng kết quả"""
    f = need(user, "masked_nll")
    log_probs, targets, mask = _batch(3, 6, 5, seed=2)
    noisy = log_probs.copy()
    noisy[~mask] = 1e6
    a = float(f(log_probs, targets, mask))
    b = float(f(noisy, targets, mask))
    assert np.isclose(a, b, atol=1e-9), "Thay log_probs ở vị trí padding làm kết quả đổi."


def test_mean_over_real_tokens(user, ref):
    """Chia cho số token thật, không chia cho B·T"""
    f = need(user, "masked_nll")
    log_probs = np.log(np.full((1, 4, 2), 0.5))
    targets = np.zeros((1, 4), dtype=int)
    mask = np.array([[1, 0, 0, 0]])
    out = float(f(log_probs, targets, mask))
    assert np.isclose(out, np.log(2), atol=1e-9), f"Một token thật với p = 0.5 phải cho log 2 ≈ 0.6931, ra {out:.4f}."


def test_empty_mask(user, ref):
    """Mask toàn 0 thì trả về 0.0"""
    f = need(user, "masked_nll")
    log_probs, targets, mask = _batch()
    out = float(f(log_probs, targets, np.zeros_like(mask)))
    assert out == 0.0, f"Ra {out}, cần 0.0."


def test_bool_or_int_mask(user, ref):
    """Mask dạng bool hay 0/1 đều được"""
    f = need(user, "masked_nll")
    log_probs, targets, mask = _batch(seed=3)
    a = float(f(log_probs, targets, mask.astype(bool)))
    b = float(f(log_probs, targets, mask.astype(int)))
    assert np.isclose(a, b, atol=1e-12), "Kết quả khác nhau giữa mask bool và mask 0/1."
