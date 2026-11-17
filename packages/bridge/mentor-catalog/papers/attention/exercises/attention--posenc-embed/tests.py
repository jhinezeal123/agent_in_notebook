V, D, L = 13, 16, 40


def _make(ns, *args, seed=0, **kw):
    t.seed(seed)
    return need(ns, "PositionalEmbedding")(*args, **kw)


def _pair(user, ref, seed):
    m = _make(user, V, D, max_len=L, seed=seed)
    r = _make(ref, V, D, max_len=L, seed=seed + 1)
    t.load_into(m, r)
    return m, r


def _tokens(shape, seed):
    return torch.randint(0, V, shape, generator=torch.Generator().manual_seed(seed))


def test_structure(user, ref):
    """embed là nn.Embedding và là tham số duy nhất; pe là buffer (max_len, d_model)"""
    m = _make(user, V, D, max_len=L)
    assert isinstance(getattr(m, "embed", None), nn.Embedding), "Chưa có thuộc tính embed là một nn.Embedding."
    params = {n: tuple(p.shape) for n, p in m.named_parameters()}
    assert params == {"embed.weight": (V, D)}, f"Tham số của module là {params}; cần đúng một tham số embed.weight ({V}, {D}): bảng PE có cần học không?"
    buffers = {n: tuple(b.shape) for n, b in m.named_buffers()}
    assert "pe" in buffers, "Chưa có buffer pe: một tensor gán thẳng vào self thì state_dict() và module.to(...) có thấy nó không?"
    assert buffers["pe"] == (L, D), f"Buffer pe có shape {buffers['pe']}, cần (max_len, d_model) = ({L}, {D})."
    assert "pe" in m.state_dict(), "pe phải nằm trong state_dict() (buffer persistent, như mặc định)."


def test_pe_values(user, ref):
    """Bảng pe đúng công thức: cột chẵn sin, cột lẻ cos, tần số đi theo cặp cột"""
    for d, max_len in [(D, L), (64, 64)]:
        m = _make(user, V, d, max_len=max_len)
        r = _make(ref, V, d, max_len=max_len)
        pe = getattr(m, "pe", None)
        assert pe is not None, "Chưa có thuộc tính pe."
        p = t.array(pe)
        assert p.shape == (max_len, d), f"pe có shape {p.shape}, cần ({max_len}, {d})."
        assert np.allclose(p[0, 0::2], 0, atol=1e-6) and np.allclose(p[0, 1::2], 1, atol=1e-6), "Hàng pos = 0 phải là [0, 1, 0, 1, …]: cột nào là sin, cột nào là cos?"
        t.close(pe, r.pe, tol=1e-4, what=f"bảng pe với d_model = {d} (kiểm số mũ của 10000 ở mỗi cột)")


def test_forward(user, ref):
    """forward: shape (B, T, d_model), khớp lời giải chuẩn khi cùng trọng số"""
    m, r = _pair(user, ref, seed=1)
    x = _tokens((2, 7), 3)
    out = m(x)
    t.shape(out, (2, 7, D), what="PositionalEmbedding với tokens (2, 7)")
    assert out.dtype == torch.float32, f"Đầu ra có kiểu {out.dtype}, cần float32: bảng pe của bạn tạo bằng kiểu số nào?"
    t.close(out, r(x), tol=1e-4, what="đầu ra (embedding đã được nhân với hệ số nào? cộng những hàng nào của pe?)")


def test_lengths(user, ref):
    """Chạy với T = 1 và T = max_len; cùng một token ở hai vị trí cho hai vector khác nhau"""
    m, r = _pair(user, ref, seed=4)
    x1 = _tokens((3, 1), 6)
    t.close(m(x1), r(x1), tol=1e-4, what="đầu ra với T = 1")
    xl = _tokens((1, L), 7)
    t.close(m(xl), r(xl), tol=1e-4, what=f"đầu ra với T = max_len = {L}")
    same = torch.full((1, 5), 4, dtype=torch.long)
    out = t.array(m(same))[0]
    assert not np.allclose(out[0], out[3]), "Cùng một token ở vị trí 0 và 3 cho cùng một vector: vị trí chưa được cộng vào."


def test_init(user, ref):
    """embed khởi tạo normal(0, d_model^-1/2): nhân √d_model xong cùng cỡ với pe"""
    m = _make(user, 1000, 64, max_len=8, seed=8)
    w = t.array(m.embed.weight)
    assert abs(w.mean()) < 0.01, f"Trung bình của embed.weight là {w.mean():.4f}, cần ≈ 0."
    assert 0.11 < w.std() < 0.14, f"Độ lệch chuẩn của embed.weight là {w.std():.4f}, cần ≈ d_model^-1/2 = 0.125: nhân √d_model xong, embedding lấn át pe hay cân với nó?"
    other = _make(user, 1000, 64, max_len=8, seed=9)
    assert not np.allclose(w, t.array(other.embed.weight)), "Hai seed khác nhau mà embed.weight giống hệt: khởi tạo phải ngẫu nhiên."
