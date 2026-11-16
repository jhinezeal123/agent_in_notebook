def _data(N=2, C=3, H=7, W=9, F=4, kh=3, kw=2, seed=0):
    rng = np.random.default_rng(seed)
    return rng.normal(size=(N, C, H, W)), rng.normal(size=(F, C, kh, kw)), rng.normal(size=F)


def _run(f, *args, **kw):
    out = f(*args, **kw)
    assert out is not None, "Hàm chưa trả về gì."
    return np.asarray(out, dtype=float)


def test_output_shape(user, ref):
    """Shape output đúng công thức với nhiều stride/padding"""
    f = need(user, "conv2d")
    x, w, b = _data()
    for s, p in [(1, 0), (1, 1), (2, 0), (2, 1), (3, 2), (2, 3)]:
        out = _run(f, x, w, b, stride=s, padding=p)
        want = ref["conv2d"](x, w, b, stride=s, padding=p).shape
        assert out.shape == want, f"stride={s}, padding={p}: output có shape {out.shape}, cần {want}. Kiểm công thức kích thước (pad mấy phía? phép chia làm tròn thế nào?)."


def test_values_basic(user, ref):
    """Đúng giá trị: stride 1, không padding"""
    f = need(user, "conv2d")
    x, w, b = _data(seed=1)
    out = _run(f, x, w, b)
    want = ref["conv2d"](x, w, b)
    assert out.shape == want.shape, f"Shape {out.shape}, cần {want.shape}."
    flipped = ref["conv2d"](x, w[:, :, ::-1, ::-1], b)
    assert not np.allclose(out, flipped, atol=1e-8), "Kết quả khớp với kernel bị lật 180°: deep learning dùng cross-correlation, kernel giữ nguyên hướng."
    assert np.allclose(out, want, atol=1e-8), "Giá trị chưa đúng: mỗi output cộng qua những kênh và offset nào?"


def test_values_stride_padding(user, ref):
    """Đúng giá trị với stride 2, padding 1, ảnh và kernel không vuông"""
    f = need(user, "conv2d")
    x, w, b = _data(N=3, C=2, H=8, W=11, F=5, kh=3, kw=4, seed=2)
    out = _run(f, x, w, b, stride=2, padding=1)
    want = ref["conv2d"](x, w, b, stride=2, padding=1)
    assert out.shape == want.shape, f"Shape {out.shape}, cần {want.shape}."
    assert np.allclose(out, want, atol=1e-8), "Sai khi có stride/padding: output (i, j) ứng với ô nào của ảnh đã pad?"


def test_cross_correlation(user, ref):
    """Không lật kernel (cross-correlation như PyTorch)"""
    f = need(user, "conv2d")
    x = np.zeros((1, 1, 5, 5))
    x[0, 0, 2, 2] = 1.0
    w = np.arange(1.0, 10.0).reshape(1, 1, 3, 3)
    out = _run(f, x, w, np.zeros(1))
    if out.shape == (1, 1, 3, 3) and np.allclose(out, ref["conv2d"](x, w[:, :, ::-1, ::-1], np.zeros(1))):
        raise AssertionError("Kernel đang bị lật: đó là convolution của toán, còn deep learning trượt kernel giữ nguyên hướng.")
    want = ref["conv2d"](x, w, np.zeros(1))
    assert out.shape == want.shape and np.allclose(out, want), "Ảnh một điểm sáng cho kết quả chưa đúng: đối chiếu với thí nghiệm trong phòng công thức."


def test_bias_per_channel(user, ref):
    """Bias: mỗi kênh ra cộng đúng một lần b[f]"""
    f = need(user, "conv2d")
    x = np.zeros((2, 3, 6, 6))
    w = np.random.default_rng(3).normal(size=(4, 3, 3, 3))
    b = np.array([1.0, -2.0, 0.5, 3.0])
    out = _run(f, x, w, b, padding=1)
    assert out.shape == (2, 4, 6, 6), f"Shape {out.shape}, cần (2, 4, 6, 6)."
    assert np.allclose(out, b.reshape(1, 4, 1, 1)), "Ảnh toàn 0 thì output trên kênh f phải đúng bằng b[f]: bias cộng mấy lần, theo trục nào?"


def test_zero_padding(user, ref):
    """Padding là số 0 và chỉ thêm vào H, W"""
    f = need(user, "conv2d")
    x = np.ones((1, 2, 4, 4))
    w = np.ones((1, 2, 3, 3))
    out = _run(f, x, w, np.zeros(1), padding=1)
    assert out.shape == (1, 1, 4, 4), f"Shape {out.shape}, cần (1, 1, 4, 4): pad những trục nào?"
    assert np.isclose(out[0, 0, 0, 0], 8.0) and np.isclose(out[0, 0, 1, 1], 18.0), "Ở góc, cửa sổ phủ một phần lên viền pad: viền đó phải là số 0."


def test_one_by_one(user, ref):
    """Kernel 1×1 là phép trộn kênh tại từng điểm ảnh"""
    f = need(user, "conv2d")
    rng = np.random.default_rng(5)
    x, w, b = rng.normal(size=(2, 5, 4, 3)), rng.normal(size=(6, 5, 1, 1)), rng.normal(size=6)
    out = _run(f, x, w, b)
    want = np.einsum("nchw,fc->nfhw", x, w[:, :, 0, 0]) + b[None, :, None, None]
    assert out.shape == want.shape and np.allclose(out, want, atol=1e-8), "Với kernel 1×1, output[n, :, i, j] phải là W·x[n, :, i, j] + b."
