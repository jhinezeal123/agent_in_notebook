import warnings


def test_rows_sum_to_one(user, ref):
    """exp(log_softmax) cộng theo trục bằng 1"""
    f = need(user, "log_softmax")
    z = np.random.default_rng(0).normal(size=(4, 6))
    out = np.asarray(f(z), dtype=float)
    assert out.shape == z.shape, f"Shape là {out.shape}, cần {z.shape}."
    assert np.allclose(np.exp(out).sum(-1), 1), "exp(log_softmax) chưa cộng thành 1 theo trục cuối."


def test_values(user, ref):
    """Đúng giá trị"""
    f = need(user, "log_softmax")
    z = np.random.default_rng(1).normal(size=(3, 5)) * 3
    assert np.allclose(np.asarray(f(z), float), ref["log_softmax"](z)), "Giá trị chưa đúng."


def test_large_logits(user, ref):
    """Logits rất lớn (1000) không ra inf/nan"""
    f = need(user, "log_softmax")
    z = np.array([[1000.0, 1001.0, 1002.0], [-1000.0, 0.0, 1000.0]])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        out = np.asarray(f(z), float)
    assert np.isfinite(out).all(), "Có inf hoặc nan với logits lớn."
    assert np.allclose(out, ref["log_softmax"](z)), "Sai với logits lớn."


def test_axis(user, ref):
    """Tôn trọng tham số axis"""
    f = need(user, "log_softmax")
    z = np.random.default_rng(2).normal(size=(4, 3))
    out = np.asarray(f(z, axis=0), float)
    assert np.allclose(np.exp(out).sum(0), 1), "Với axis=0, phải cộng thành 1 theo trục 0."


def test_square_input(user, ref):
    """Đúng cả khi số hàng bằng số cột"""
    f = need(user, "log_softmax")
    z = np.random.default_rng(5).normal(size=(4, 4)) * 2
    assert np.allclose(np.asarray(f(z), float), ref["log_softmax"](z)), "Sai khi z vuông: kiểm lại keepdims."


def test_cross_entropy(user, ref):
    """cross_entropy đúng (trung bình trên batch)"""
    f = need(user, "cross_entropy")
    rng = np.random.default_rng(3)
    logits = rng.normal(size=(6, 4))
    targets = rng.integers(0, 4, size=6)
    out = float(f(logits, targets))
    want = ref["cross_entropy"](logits, targets)
    assert np.isclose(out, want), f"Ra {out:.5f}, cần {want:.5f}."


def test_cross_entropy_stable(user, ref):
    """cross_entropy hữu hạn với logits lớn"""
    f = need(user, "cross_entropy")
    logits = np.array([[1000.0, 0.0], [0.0, 1000.0]])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        out = float(f(logits, np.array([1, 1])))
    assert np.isfinite(out), "cross_entropy ra inf/nan với logits lớn."
    assert np.isclose(out, 500.0), f"Ra {out}, cần 500."
