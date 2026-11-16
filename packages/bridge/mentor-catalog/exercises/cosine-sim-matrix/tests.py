import time
import warnings


def _data(n, m, d, seed=0):
    rng = np.random.default_rng(seed)
    return rng.normal(size=(n, d)), rng.normal(size=(m, d))


def _call(f, X, Y, **kw):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return np.asarray(f(X, Y, **kw), dtype=float)


def test_shape(user, ref):
    """Kết quả có shape (n, m)"""
    f = need(user, "cosine_sim")
    X, Y = _data(4, 6, 3)
    out = _call(f, X, Y)
    assert out.shape == (4, 6), f"Shape là {out.shape}, cần (4, 6)."


def test_values(user, ref):
    """Đúng giá trị khi các hàng có độ dài rất khác nhau"""
    f = need(user, "cosine_sim")
    X, Y = _data(9, 5, 4, seed=1)
    rng = np.random.default_rng(11)
    X = X * rng.uniform(0.01, 100, size=(9, 1))
    Y = Y * rng.uniform(0.01, 100, size=(5, 1))
    out = _call(f, X, Y)
    want = ref["cosine_sim"](X, Y)
    assert out.shape == want.shape, f"Shape là {out.shape}, cần {want.shape}."
    assert np.allclose(out, want, atol=1e-8), "Giá trị chưa đúng: chia cho chuẩn của TỪNG HÀNG của cả X và Y (chuẩn theo trục d)."


def test_self_similarity(user, ref):
    """S(X, X) có đường chéo bằng 1, mọi giá trị trong [−1, 1], không đổi khi scale hàng"""
    f = need(user, "cosine_sim")
    X, _ = _data(6, 1, 3, seed=2)
    out = _call(f, X, X)
    assert np.allclose(np.diag(out), 1, atol=1e-8), "Đường chéo của S(X, X) phải bằng 1."
    assert (np.abs(out) <= 1 + 1e-9).all(), "Có cosine nằm ngoài [−1, 1]: thiếu chia cho chuẩn."
    scaled = _call(f, X * np.arange(1, 7)[:, None], X)
    assert np.allclose(scaled, out, atol=1e-8), "Nhân hàng của X với số dương mà cosine đổi: cosine chỉ phụ thuộc hướng."


def test_one_dimension(user, ref):
    """Chạy đúng khi d = 1"""
    f = need(user, "cosine_sim")
    X = np.array([[2.0], [-3.0]])
    Y = np.array([[1.0], [-0.5], [4.0]])
    out = _call(f, X, Y)
    want = np.array([[1.0, -1.0, 1.0], [-1.0, 1.0, -1.0]])
    assert out.shape == (2, 3), f"Shape là {out.shape}, cần (2, 3)."
    assert np.allclose(out, want, atol=1e-8), "Sai với d = 1 (cosine phải là ±1 theo dấu)."


def test_zero_and_tiny_rows(user, ref):
    """Hàng toàn 0 cho 0 (không nan); hàng rất nhỏ dùng max(||x||, ε)"""
    f = need(user, "cosine_sim")
    X, Y = _data(3, 4, 5, seed=4)
    X[1] = 0.0
    Y[2] = 0.0
    out = _call(f, X, Y)
    assert np.isfinite(out).all(), "Có nan/inf khi có hàng toàn 0: kẹp chuẩn dưới bằng ε."
    assert np.allclose(out[1], 0) and np.allclose(out[:, 2], 0), "Hàng/cột ứng với vector 0 phải bằng 0."
    X[1] = 1e-10
    out = _call(f, X, Y)
    want = ref["cosine_sim"](X, Y)
    assert np.allclose(out, want, rtol=1e-6, atol=1e-12), "Sai với hàng có chuẩn nhỏ hơn ε: mẫu số là max(||x||, ε), không phải ||x|| + ε."


def test_vectorized(user, ref):
    """Không dùng vòng lặp (đủ nhanh với 800 × 800 điểm)"""
    f = need(user, "cosine_sim")
    X, Y = _data(800, 800, 16, seed=3)
    start = time.perf_counter()
    f(X, Y)
    took = time.perf_counter() - start
    assert took < 3.0, f"Mất {took:.1f} s: có vẻ còn vòng lặp Python."
