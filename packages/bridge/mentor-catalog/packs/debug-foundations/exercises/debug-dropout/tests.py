import warnings


def _fwd(user, x, p, seed=0, training=True):
    res = need(user, "dropout_forward")(x, p, np.random.default_rng(seed), training=training)
    assert isinstance(res, tuple) and len(res) == 2, "dropout_forward phải trả về (out, mask)."
    out, mask = res
    return np.asarray(out, float), (None if mask is None else np.asarray(mask))


def _check_mask(mask, shape):
    assert mask is not None, "Khi train, mask không được là None."
    assert mask.shape == shape, f"mask có shape {mask.shape}, cần {shape}."
    assert mask.dtype == bool, f"mask phải là mảng bool, đang là {mask.dtype}."


def test_eval_identity(user, ref):
    """Eval: out = x, mask = None, x không bị sửa"""
    x = np.random.default_rng(1).normal(size=(6, 7))
    keep = x.copy()
    out, mask = _fwd(user, x, 0.5, training=False)
    assert np.array_equal(x, keep), "x bị sửa tại chỗ."
    assert out.shape == x.shape and np.array_equal(out, x), "Khi eval, out phải bằng đúng x (không bỏ, không phóng, không thu nhỏ)."
    assert mask is None, "Khi eval, mask phải là None."


def test_forward_consistent(user, ref):
    """Train: phần tử giữ lại được phóng 1/(1−p), phần tử bỏ bằng 0"""
    x = np.random.default_rng(2).normal(size=(50, 40))
    keep = x.copy()
    out, mask = _fwd(user, x, 0.3, seed=3)
    _check_mask(mask, x.shape)
    assert np.array_equal(x, keep), "x bị sửa tại chỗ."
    assert np.allclose(out[~mask], 0), "Phần tử bị bỏ (mask False) phải bằng 0."
    assert np.allclose(out[mask], x[mask] / 0.7), "Phần tử được giữ chưa đúng giá trị: nó phải được nhân với bao nhiêu?"


def test_keep_rate(user, ref):
    """Tỉ lệ phần tử được giữ ≈ 1 − p"""
    x = np.ones((400, 500))
    for p in [0.3, 0.8]:
        _, mask = _fwd(user, x, p, seed=4)
        _check_mask(mask, x.shape)
        assert abs(mask.mean() - (1 - p)) < 0.01, f"Với p = {p}, bạn giữ {mask.mean():.1%} phần tử. p là xác suất bỏ hay xác suất giữ?"


def test_expectation(user, ref):
    """Kỳ vọng được bảo toàn: trung bình của out ≈ trung bình của x"""
    x = np.full((400, 500), 2.0)
    out, _ = _fwd(user, x, 0.2, seed=5)
    assert abs(out.mean() - 2.0) < 0.02, f"x toàn 2 mà trung bình out là {out.mean():.3f}: kỳ vọng chưa được giữ."


def test_independent_and_seeded(user, ref):
    """Mask độc lập theo từng phần tử và chỉ phụ thuộc rng"""
    x = np.ones((2000, 20))
    _, m1 = _fwd(user, x, 0.5, seed=6)
    _, m2 = _fwd(user, x, 0.5, seed=6)
    _, m3 = _fwd(user, x, 0.5, seed=7)
    _check_mask(m1, x.shape)
    assert np.array_equal(m1, m2), "Cùng seed mà hai lần ra hai mask khác nhau: số ngẫu nhiên phải lấy từ rng."
    assert not np.array_equal(m1, m3), "Hai seed khác nhau mà ra cùng mask."
    const_rows = np.mean(m1.all(1) | (~m1).all(1))
    const_cols = np.mean(m1.all(0) | (~m1).all(0))
    assert const_rows < 0.05 and const_cols < 0.05, "Mask đang giống nhau dọc cả một hàng hoặc một cột: mỗi phần tử phải được bỏ độc lập."


def test_edge_p(user, ref):
    """p = 0, p = 1 và p ngoài [0, 1]"""
    x = np.random.default_rng(8).normal(size=(5, 6))
    out, mask = _fwd(user, x, 0.0)
    _check_mask(mask, x.shape)
    assert np.allclose(out, x) and mask.all(), "Với p = 0, không phần tử nào bị bỏ và out = x."
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        out, mask = _fwd(user, x, 1.0)
    _check_mask(mask, x.shape)
    assert np.isfinite(out).all(), "Với p = 1, out có nan/inf: 1 − p bằng bao nhiêu?"
    assert np.allclose(out, 0) and not mask.any(), "Với p = 1, mọi phần tử bị bỏ, out toàn 0."
    for bad in [-0.1, 1.5]:
        try:
            _fwd(user, x, bad)
        except ValueError:
            continue
        raise AssertionError(f"p = {bad} phải raise ValueError.")


def test_backward(user, ref):
    """Backward dùng đúng mask và đúng hệ số; eval và p = 1 không lỗi"""
    g = need(user, "dropout_backward")
    rng = np.random.default_rng(9)
    G = rng.normal(size=(4, 6))
    mask = rng.random((4, 6)) < 0.6
    got = np.asarray(g(G, mask, 0.25), float)
    assert got.shape == G.shape, f"Gradient có shape {got.shape}, cần {G.shape}."
    assert np.allclose(got, ref["dropout_backward"](G, mask, 0.25)), "Gradient chưa đúng: forward làm gì với phần tử được giữ thì backward cũng phải làm vậy."
    assert np.allclose(np.asarray(g(G, None, 0.25), float), G), "mask = None (eval) thì gradient phải đi qua nguyên vẹn."
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        zero = np.asarray(g(G, np.zeros((4, 6), bool), 1.0), float)
    assert np.isfinite(zero).all() and np.allclose(zero, 0), "Với p = 1, gradient phải toàn 0, không nan."
    x = rng.normal(size=(4, 6))
    out, m = _fwd(user, x, 0.4, seed=10)
    gx = np.asarray(g(G, m, 0.4), float)
    assert np.isclose((out * G).sum(), (x * gx).sum()), "Backward không khớp với forward của chính bạn: dropout tuyến tính theo x nên sum(out·G) phải bằng sum(x·dx)."
