import time


def _data(n, m, d, seed=0):
    rng = np.random.default_rng(seed)
    return rng.normal(size=(n, d)), rng.normal(size=(m, d))


def test_shape(user, ref):
    """Kết quả có shape (n, m)"""
    f = need(user, "pairwise_sqdist")
    X, Y = _data(4, 6, 3)
    out = np.asarray(f(X, Y))
    assert out.shape == (4, 6), f"Shape là {out.shape}, cần (4, 6)."


def test_values(user, ref):
    """Đúng giá trị trên dữ liệu ngẫu nhiên"""
    f = need(user, "pairwise_sqdist")
    X, Y = _data(9, 5, 4, seed=1)
    out = np.asarray(f(X, Y), dtype=float)
    want = ref["pairwise_sqdist"](X, Y)
    assert out.shape == want.shape, f"Shape là {out.shape}, cần {want.shape}."
    assert np.allclose(out, want, atol=1e-8), "Giá trị chưa đúng: thử tự tính tay D[0, 0] với một ví dụ nhỏ."


def test_one_dimension(user, ref):
    """Chạy đúng khi d = 1"""
    f = need(user, "pairwise_sqdist")
    X = np.array([[0.0], [3.0]])
    Y = np.array([[1.0], [-1.0], [3.0]])
    out = np.asarray(f(X, Y), dtype=float)
    want = np.array([[1.0, 1.0, 9.0], [4.0, 16.0, 0.0]])
    assert out.shape == (2, 3), f"Shape là {out.shape}, cần (2, 3)."
    assert np.allclose(out, want, atol=1e-8), "Sai với d = 1."


def test_self_distance(user, ref):
    """Khoảng cách từ một điểm đến chính nó bằng 0 và không âm"""
    f = need(user, "pairwise_sqdist")
    X, _ = _data(6, 1, 3, seed=2)
    out = np.asarray(f(X, X), dtype=float)
    assert np.allclose(np.diag(out), 0, atol=1e-8), "Đường chéo của D(X, X) phải bằng 0."
    assert (out > -1e-8).all(), "Có khoảng cách âm."


def test_vectorized(user, ref):
    """Không dùng vòng lặp (đủ nhanh với 800 × 800 điểm)"""
    f = need(user, "pairwise_sqdist")
    X, Y = _data(800, 800, 16, seed=3)
    start = time.perf_counter()
    f(X, Y)
    took = time.perf_counter() - start
    assert took < 3.0, f"Mất {took:.1f} s: có vẻ còn vòng lặp Python."
