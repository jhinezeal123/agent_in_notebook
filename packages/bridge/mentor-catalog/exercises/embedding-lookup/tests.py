def _data(shape=(3, 5), V=7, d=4, seed=0):
    rng = np.random.default_rng(seed)
    return rng.integers(0, V, size=shape), rng.normal(size=(V, d)), rng.normal(size=tuple(shape) + (d,))


def test_forward_batch(user, ref):
    """Forward với ids shape (B, T): ra (B, T, d) và đúng hàng"""
    f = need(user, "embedding_forward")
    ids, W, _ = _data()
    out = np.asarray(f(ids, W), float)
    assert out.shape == (3, 5, 4), f"Shape là {out.shape}, cần ids.shape + (d,) = (3, 5, 4)."
    assert np.allclose(out, ref["embedding_forward"](ids, W)), "Giá trị chưa đúng: vị trí (b, t) phải là hàng ids[b, t] của W."


def test_forward_any_shape(user, ref):
    """Forward với id vô hướng và ids 1 chiều"""
    f = need(user, "embedding_forward")
    _, W, _ = _data()
    out = np.asarray(f(np.int64(2), W), float)
    assert out.shape == (4,), f"Với một id vô hướng, shape là {out.shape}, cần (d,) = (4,)."
    assert np.allclose(out, W[2]), "Với một id vô hướng, kết quả phải là đúng một hàng của W."
    ids = np.array([6, 0, 6])
    out = np.asarray(f(ids, W), float)
    assert out.shape == (3, 4) and np.allclose(out, ref["embedding_forward"](ids, W)), "Sai với ids 1 chiều."


def test_forward_out_of_range(user, ref):
    """Id ngoài [0, V) bị từ chối, kể cả id âm"""
    f = need(user, "embedding_forward")
    _, W, _ = _data()
    for bad in ([0, 7], [[1, -1]]):
        try:
            f(np.array(bad), W)
        except IndexError:
            continue
        raise AssertionError(f"ids = {bad} với V = 7 phải raise IndexError. NumPy tự hiểu id âm theo cách riêng của nó mà không báo lỗi.")


def test_backward_shape(user, ref):
    """Backward trả về (V, d), hàng của id không xuất hiện bằng 0"""
    g = need(user, "embedding_backward")
    ids = np.array([[1, 4], [5, 2]])
    G = np.random.default_rng(1).normal(size=(2, 2, 3))
    dW = np.asarray(g(ids, G, 7), float)
    assert dW.shape == (7, 3), f"dW có shape {dW.shape}, cần (V, d) = (7, 3)."
    assert np.allclose(dW[[0, 3, 6]], 0), "Hàng của các id không xuất hiện phải bằng 0."


def test_backward_unique(user, ref):
    """Backward đúng khi mọi id khác nhau"""
    g = need(user, "embedding_backward")
    rng = np.random.default_rng(2)
    ids = rng.permutation(10)[:6].reshape(2, 3)
    G = rng.normal(size=(2, 3, 5))
    assert np.allclose(np.asarray(g(ids, G, 10), float), ref["embedding_backward"](ids, G, 10)), "Gradient chưa đúng ngay cả khi không có id lặp."


def test_backward_repeated(user, ref):
    """Id lặp lại thì gradient cộng dồn (trong cùng câu và giữa các câu)"""
    g = need(user, "embedding_backward")
    ids = np.array([[3, 3, 1], [3, 0, 1]])
    G = np.ones((2, 3, 2))
    dW = np.asarray(g(ids, G, 5), float)
    assert np.allclose(dW[3], 3) and np.allclose(dW[1], 2), (
        f"Token 3 xuất hiện 3 lần, token 1 xuất hiện 2 lần, mỗi lần gradient toàn 1; bạn ra hàng 3 = {dW[3]}, hàng 1 = {dW[1]}. "
        "Thử nghĩ: phép cộng qua fancy indexing xử lý chỉ số trùng thế nào?"
    )


def test_backward_many_repeats(user, ref):
    """Đúng gradient của L = sum(out * G) khi batch có rất nhiều id trùng"""
    g = need(user, "embedding_backward")
    ids, _, G = _data(shape=(8, 12), V=5, d=3, seed=3)
    dW = np.asarray(g(ids, G, 5), float)
    assert np.allclose(dW, ref["embedding_backward"](ids, G, 5)), "Gradient chưa đúng khi batch có nhiều id trùng nhau."
