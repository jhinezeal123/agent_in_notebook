def _x(shape, seed=0, scale=1.0, loc=2.0):
    rng = np.random.default_rng(seed)
    return rng.normal(loc=loc, scale=scale, size=shape)


def test_shape(user, ref):
    """Giữ nguyên shape"""
    f = need(user, "rms_norm")
    x = _x((4, 8))
    out = np.asarray(f(x, np.ones(8)))
    assert out.shape == (4, 8), f"Shape là {out.shape}, cần (4, 8)."


def test_unit_rms(user, ref):
    """Mỗi hàng có RMS bằng 1 (gamma = 1), trung bình không bị ép về 0"""
    f = need(user, "rms_norm")
    x = _x((5, 16), seed=1, scale=3.0)
    out = np.asarray(f(x, np.ones(16)), float)
    rms = np.sqrt((out ** 2).mean(-1))
    assert np.allclose(rms, 1, atol=1e-4), f"RMS mỗi hàng là {np.round(rms, 3)}, cần 1: chia cho căn của trung bình x² (không phải tổng, không phải phương sai)."
    assert not np.allclose(out.mean(-1), 0, atol=1e-3), "Trung bình mỗi hàng bị đưa về 0: RMSNorm không trừ trung bình."


def test_values(user, ref):
    """Đúng giá trị với gamma ngẫu nhiên, mỗi token một thang đo"""
    f = need(user, "rms_norm")
    rng = np.random.default_rng(2)
    x = _x((4, 8), seed=2) * np.array([[0.1], [1.0], [5.0], [30.0]])
    g = rng.normal(size=8)
    assert np.allclose(np.asarray(f(x, g), float), ref["rms_norm"](x, g), atol=1e-7), "Giá trị chưa đúng: thống kê phải lấy riêng cho từng token (trục cuối), không trừ trung bình."


def test_constant_token(user, ref):
    """Token hằng số không bị xoá về 0 (khác LayerNorm)"""
    f = need(user, "rms_norm")
    x = np.array([[7.0] * 4, [-3.0] * 4])
    g = np.array([1.0, 2.0, 0.5, -1.0])
    out = np.asarray(f(x, g), float)
    assert np.isfinite(out).all(), "Ra nan/inf với token hằng số."
    assert np.allclose(out, ref["rms_norm"](x, g), atol=1e-6), "Token hằng số c phải ra ≈ sign(c)·gamma: RMSNorm không trừ trung bình (LayerNorm mới ra 0 ở đây), thống kê lấy riêng từng token."


def test_eps_inside_sqrt(user, ref):
    """ε nằm trong căn (token có giá trị rất nhỏ, ms(x) cỡ ε)"""
    f = need(user, "rms_norm")
    x = _x((3, 8), seed=3, scale=1e-3, loc=0.0)
    g = np.ones(8)
    out = np.asarray(f(x, g), float)
    assert np.allclose(out, ref["rms_norm"](x, g), atol=1e-6), "Sai khi giá trị rất nhỏ: ε phải cộng vào trung bình bình phương, bên trong căn."
    z = np.asarray(f(np.zeros((2, 8)), g), float)
    assert np.isfinite(z).all() and np.allclose(z, 0), "Token toàn số 0 phải ra 0, không ra nan."


def test_3d(user, ref):
    """Chạy với x shape (B, T, d)"""
    f = need(user, "rms_norm")
    rng = np.random.default_rng(4)
    x = _x((2, 3, 6), seed=4) * rng.uniform(0.1, 10, size=(2, 3, 1))
    g = rng.normal(size=6)
    out = np.asarray(f(x, g), float)
    assert out.shape == (2, 3, 6), f"Shape là {out.shape}, cần (2, 3, 6)."
    assert np.allclose(out, ref["rms_norm"](x, g), atol=1e-7), "Sai với tensor 3 chiều: chuẩn hoá theo trục cuối, riêng từng token."
