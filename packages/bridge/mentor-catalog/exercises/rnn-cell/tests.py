def _setup(B=3, T=5, d_in=4, d_h=6, seed=0):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(B, T, d_in))
    h0 = rng.normal(size=(B, d_h)) * 0.5
    Wx = rng.normal(size=(d_in, d_h)) / np.sqrt(d_in)
    Wh = rng.normal(size=(d_h, d_h)) / np.sqrt(d_h)
    b = rng.normal(size=d_h) * 0.1
    return x, h0, Wx, Wh, b


def _run(user, x, h0, Wx, Wh, b):
    res = need(user, "rnn_forward")(x, h0, Wx, Wh, b)
    assert isinstance(res, tuple) and len(res) == 2, "rnn_forward phải trả về (hs, h_last)."
    return np.asarray(res[0], float), np.asarray(res[1], float)


def test_step(user, ref):
    """rnn_step: shape (B, d_h) và đúng giá trị"""
    f = need(user, "rnn_step")
    x, h0, Wx, Wh, b = _setup(seed=1)
    out = np.asarray(f(x[:, 0], h0, Wx, Wh, b), float)
    assert out.shape == (3, 6), f"rnn_step ra shape {out.shape}, cần (B, d_h) = (3, 6)."
    assert np.allclose(out, ref["rnn_step"](x[:, 0], h0, Wx, Wh, b)), "rnn_step chưa đúng giá trị: kiểm lại thứ tự nhân với từng ma trận trọng số."


def test_shapes(user, ref):
    """rnn_forward: hs (B, T, d_h), h_last (B, d_h)"""
    hs, last = _run(user, *_setup())
    assert hs.shape == (3, 5, 6), f"hs có shape {hs.shape}, cần (B, T, d_h) = (3, 5, 6)."
    assert last.shape == (3, 6), f"h_last có shape {last.shape}, cần (B, d_h) = (3, 6)."


def test_values(user, ref):
    """Đúng giá trị mọi bước, kể cả khi B = T"""
    for shape in [dict(B=4, T=4), dict(B=3, T=5)]:
        args = _setup(seed=2, **shape)
        hs, last = _run(user, *args)
        want, want_last = ref["rnn_forward"](*args)
        assert hs.shape == want.shape, f"Với B = {shape['B']}, T = {shape['T']}: hs có shape {hs.shape}, cần {want.shape}."
        wrong = [t for t in range(want.shape[1]) if not np.allclose(hs[:, t], want[:, t])]
        assert not wrong, f"Với B = {shape['B']}, T = {shape['T']}: hs sai từ bước t = {wrong[0]} (các bước sai: {wrong}). Trục nào là thời gian? Trạng thái có được mang sang bước sau không?"
        assert np.allclose(last, want_last), "h_last chưa đúng: nó phải là trạng thái sau bước cuối cùng."


def test_h0(user, ref):
    """h0 được dùng, None nghĩa là 0, và h0 không bị sửa"""
    x, h0, Wx, Wh, b = _setup(seed=3)
    keep = h0.copy()
    hs, _ = _run(user, x, h0, Wx, Wh, b)
    assert np.array_equal(h0, keep), "h0 bị sửa tại chỗ sau khi gọi rnn_forward."
    assert np.allclose(hs, ref["rnn_forward"](x, h0, Wx, Wh, b)[0]), "Kết quả chưa đúng với h0 khác 0: h0 có được dùng ở bước đầu không?"
    hz, _ = _run(user, x, None, Wx, Wh, b)
    assert np.allclose(hz, ref["rnn_forward"](x, np.zeros_like(h0), Wx, Wh, b)[0]), "Với h0 = None, kết quả phải như khi h0 toàn 0."


def test_causal(user, ref):
    """Đổi x ở bước 3 chỉ ảnh hưởng hs từ bước 3 trở đi"""
    x, h0, Wx, Wh, b = _setup(T=7, seed=4)
    hs, _ = _run(user, x, h0, Wx, Wh, b)
    x2 = x.copy()
    x2[:, 3] += 1.0
    hs2, _ = _run(user, x2, h0, Wx, Wh, b)
    assert np.allclose(hs[:, :3], hs2[:, :3]), "Đổi x ở bước 3 mà các bước 0..2 cũng đổi: trạng thái ở bước t chỉ được phụ thuộc quá khứ."
    assert not np.allclose(hs[:, 3:], hs2[:, 3:]), "Đổi x ở bước 3 mà các bước sau không đổi."
    assert not np.allclose(hs2[:, -1], hs[:, -1]), "Trạng thái cuối không nhớ gì về bước 3."


def test_empty_sequence(user, ref):
    """Chuỗi rỗng (T = 0): hs rỗng, h_last = h0"""
    _, h0, Wx, Wh, b = _setup(seed=5)
    x = np.zeros((3, 0, 4))
    hs, last = _run(user, x, h0, Wx, Wh, b)
    assert hs.shape == (3, 0, 6), f"Với T = 0, hs có shape {hs.shape}, cần (3, 0, 6)."
    assert last.shape == (3, 6) and np.allclose(last, h0), "Với T = 0, chưa đọc gì nên h_last phải bằng h0."
