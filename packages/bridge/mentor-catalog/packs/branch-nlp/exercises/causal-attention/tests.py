C, H = 16, 4


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _pair(user, ref, c=C, h=H, seed=0):
    t.seed(seed)
    m = need(user, "CausalSelfAttention")(c, h)
    t.seed(seed + 1)
    r = ref["CausalSelfAttention"](c, h)
    t.load_into(m, r)
    return m, r


def test_parameters(user, ref):
    """Đúng hai nn.Linear: qkv (C → 3C) và proj (C → C), không tham số hay buffer nào khác"""
    t.seed(0)
    m = need(user, "CausalSelfAttention")(C, H)
    for name in ["qkv", "proj"]:
        assert isinstance(getattr(m, name, None), nn.Linear), f"Chưa có thuộc tính {name} là một nn.Linear."
    assert tuple(m.qkv.weight.shape) == (3 * C, C), f"qkv.weight có shape {tuple(m.qkv.weight.shape)}, cần ({3 * C}, {C}): qkv tạo cả q, k, v một lúc."
    assert tuple(m.proj.weight.shape) == (C, C), f"proj.weight có shape {tuple(m.proj.weight.shape)}, cần ({C}, {C})."
    assert m.qkv.bias is not None and m.proj.bias is not None, "qkv và proj đều có bias (đừng đặt bias=False)."
    keys = sorted(m.state_dict().keys())
    want = ["proj.bias", "proj.weight", "qkv.bias", "qkv.weight"]
    assert keys == want, f"state_dict của module là {keys}, cần đúng {want}: mask dựng trong forward theo T, không lưu trong state_dict."


def test_values(user, ref):
    """Đầu ra (B, T, C) khớp lời giải chuẩn khi cùng trọng số"""
    m, r = _pair(user, ref, seed=1)
    x = torch.randn(2, 6, C, generator=_g(2))
    out = m(x)
    t.shape(out, (2, 6, C), what="CausalSelfAttention(16, 4) với x (2, 6, 16)")
    t.close(out, r(x), what="đầu ra (kiểm hệ số scale, cách tách và ghép head, và mask)")


def test_no_future(user, ref):
    """Đổi token ở vị trí p thì đầu ra ở các vị trí trước p không đổi"""
    m, r = _pair(user, ref, seed=3)
    x = torch.randn(2, 7, C, generator=_g(4))
    out = m(x)
    assert np.isfinite(t.array(out)).all(), "Đầu ra có NaN/inf: có hàng nào của mask che hết mọi key không?"
    g = _g(5)
    for p in [1, 4, 6]:
        x2 = x.clone()
        x2[:, p] = 3 * torch.randn(2, C, generator=g)
        out2 = m(x2)
        t.close(out2[:, :p], out[:, :p], tol=1e-5, what=f"đầu ra ở {p} vị trí đầu khi chỉ đổi token ở vị trí {p} (vị trí trước p đang nhìn thấy tương lai)")
        assert float((out2[:, p] - out[:, p]).abs().max()) > 1e-3, f"Đổi token ở vị trí {p} mà đầu ra ở chính vị trí {p} không đổi: mask có che cả đường chéo không?"


def test_gradient_no_future(user, ref):
    """Gradient của đầu ra ở vị trí 2 không chảy về các token ở vị trí sau 2"""
    m, r = _pair(user, ref, seed=6)
    x = torch.randn(2, 6, C, generator=_g(7)).requires_grad_(True)
    out = m(x)
    out[:, 2].sum().backward()
    assert x.grad is not None, "x không nhận được gradient nào: có thao tác detach hoặc ngoài đồ thị không?"
    future = float(x.grad[:, 3:].abs().max())
    past = float(x.grad[:, :3].abs().max())
    assert future < 1e-8, f"Gradient chảy từ vị trí 2 về các token ở vị trí 3..5 (độ lớn {future:.1e}): thông tin tương lai đang lọt vào."
    assert past > 1e-6, "Vị trí 2 không nhận gradient từ các token 0..2: đầu ra ở 2 phải phụ thuộc vào chúng."
    t.close(x.grad, _ref_grad(r, x.detach()), tol=1e-4, what="gradient theo x")


def _ref_grad(r, x):
    x = x.clone().requires_grad_(True)
    r(x)[:, 2].sum().backward()
    return x.grad


def test_first_token_sees_itself(user, ref):
    """Vị trí 0 chỉ nhìn chính nó: đầu ra bằng phép chiếu của đúng v ở vị trí 0 (đường chéo được nhìn)"""
    m, _ = _pair(user, ref, seed=8)
    x = torch.randn(2, 5, C, generator=_g(9))
    out = m(x)
    assert np.isfinite(t.array(out)).all(), "Đầu ra có NaN/inf ở vị trí 0: hàng 0 của mask có ô nào được nhìn không?"
    v0 = m.qkv(x)[:, 0, 2 * C:]
    t.close(out[:, 0], m.proj(v0), what="đầu ra ở vị trí 0 (với một key duy nhất, trọng số attention phải bằng 1)")


def test_single_token(user, ref):
    """T = 1: shape (B, 1, C) và khớp lời giải chuẩn"""
    m, r = _pair(user, ref, seed=10)
    x = torch.randn(3, 1, C, generator=_g(11))
    out = m(x)
    t.shape(out, (3, 1, C), what="đầu ra với x (3, 1, 16)")
    t.close(out, r(x), what="đầu ra với T = 1")
    t.close(out, m.proj(m.qkv(x)[..., 2 * C:]), what="đầu ra với T = 1 (chỉ một token, nhìn chính nó)")


def test_heads(user, ref):
    """Số head khác nhau (6 head, 1 head, mỗi head 1 chiều); n_embd không chia hết thì ValueError"""
    for c, h, seed in [(24, 6, 12), (12, 1, 13), (8, 8, 14)]:
        m, r = _pair(user, ref, c=c, h=h, seed=seed)
        x = torch.randn(2, 5, c, generator=_g(seed)) * 2
        t.close(m(x), r(x), what=f"đầu ra với n_embd = {c}, {h} head")
    try:
        need(user, "CausalSelfAttention")(10, 3)
    except ValueError:
        return
    raise AssertionError("CausalSelfAttention(10, 3) phải raise ValueError: 10 không chia hết cho 3.")


def test_varied_length(user, ref):
    """Cùng một module chạy với nhiều độ dài T khác nhau, kể cả T = 40"""
    m, r = _pair(user, ref, seed=15)
    for T in [2, 9, 40]:
        x = torch.randn(2, T, C, generator=_g(T))
        out = m(x)
        t.shape(out, (2, T, C), what=f"đầu ra với T = {T}")
        t.close(out, r(x), what=f"đầu ra với T = {T} (mask phải theo T của đầu vào, không cố định)")


def test_no_builtin(user, ref):
    """Tự viết attention và mask, không gọi F.scaled_dot_product_attention hay nn.MultiheadAttention"""
    m, _ = _pair(user, ref, seed=16)
    for mod in m.modules():
        assert not isinstance(mod, nn.MultiheadAttention), "Bài này là tự viết attention: đừng dùng nn.MultiheadAttention."
    x = torch.randn(1, 4, C, generator=_g(17))
    original = getattr(F, "scaled_dot_product_attention", None)
    if original is None:
        return
    calls = []

    def spy(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    F.scaled_dot_product_attention = spy
    try:
        m(x)
    finally:
        F.scaled_dot_product_attention = original
    assert not calls, "Bài này là tự viết attention và mask: đừng gọi F.scaled_dot_product_attention."
