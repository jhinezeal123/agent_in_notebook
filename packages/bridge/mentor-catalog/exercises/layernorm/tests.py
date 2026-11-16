def _x(shape, seed=0, scale=1.0):
    rng = np.random.default_rng(seed)
    return rng.normal(loc=2.0, scale=scale, size=shape)


def test_shape(user, ref):
    """Giữ nguyên shape"""
    f = need(user, "layer_norm")
    x = _x((4, 8))
    out = np.asarray(f(x, np.ones(8), np.zeros(8)))
    assert out.shape == (4, 8), f"Shape là {out.shape}, cần (4, 8)."


def test_normalized(user, ref):
    """Mỗi hàng có trung bình 0, phương sai 1 (gamma = 1, beta = 0)"""
    f = need(user, "layer_norm")
    x = _x((5, 16), seed=1, scale=3.0)
    out = np.asarray(f(x, np.ones(16), np.zeros(16)), float)
    assert np.allclose(out.mean(-1), 0, atol=1e-6), "Trung bình mỗi hàng chưa bằng 0: kiểm trục chuẩn hoá."
    assert np.allclose(out.var(-1), 1, atol=1e-3), "Phương sai mỗi hàng chưa bằng 1."


def test_values(user, ref):
    """Đúng giá trị với gamma, beta ngẫu nhiên"""
    f = need(user, "layer_norm")
    rng = np.random.default_rng(2)
    x = _x((3, 8), seed=2)
    g, b = rng.normal(size=8), rng.normal(size=8)
    assert np.allclose(np.asarray(f(x, g, b), float), ref["layer_norm"](x, g, b), atol=1e-7), "Giá trị chưa đúng: phương sai dùng ddof nào?"


def test_eps_inside_sqrt(user, ref):
    """ε nằm trong căn (dữ liệu có phương sai rất nhỏ)"""
    f = need(user, "layer_norm")
    x = _x((3, 8), seed=3, scale=1e-3)
    g, b = np.ones(8), np.zeros(8)
    assert np.allclose(np.asarray(f(x, g, b), float), ref["layer_norm"](x, g, b), atol=1e-6), "Sai khi phương sai rất nhỏ: ε phải nằm trong căn."


def test_constant_row(user, ref):
    """Hàng hằng số cho ra beta, không ra nan"""
    f = need(user, "layer_norm")
    x = np.full((2, 4), 7.0)
    b = np.array([0.1, 0.2, 0.3, 0.4])
    out = np.asarray(f(x, np.ones(4), b), float)
    assert np.isfinite(out).all(), "Ra nan/inf với hàng hằng số."
    assert np.allclose(out, b), "Hàng hằng số phải cho đúng beta."


def test_3d(user, ref):
    """Chạy với x shape (B, T, d)"""
    f = need(user, "layer_norm")
    rng = np.random.default_rng(4)
    x = _x((2, 3, 6), seed=4)
    g, b = rng.normal(size=6), rng.normal(size=6)
    out = np.asarray(f(x, g, b), float)
    assert out.shape == (2, 3, 6), f"Shape là {out.shape}, cần (2, 3, 6)."
    assert np.allclose(out, ref["layer_norm"](x, g, b), atol=1e-7), "Sai với tensor 3 chiều: chuẩn hoá theo trục cuối."
