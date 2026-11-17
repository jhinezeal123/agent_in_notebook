D, H = 16, 4
NAMES = ["w_q", "w_k", "w_v", "w_o"]


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _pair(user, ref, d=D, h=H, seed=0):
    t.seed(seed)
    m = need(user, "MultiHeadAttention")(d, h)
    t.seed(seed + 1)
    r = ref["MultiHeadAttention"](d, h)
    t.load_into(m, r)
    return m, r


def _qkv(seed, tq, tk, b=2, d=D):
    g = _g(seed)
    return torch.randn(b, tq, d, generator=g), torch.randn(b, tk, d, generator=g), torch.randn(b, tk, d, generator=g)


def test_parameters(user, ref):
    """Đúng bốn nn.Linear w_q, w_k, w_v, w_o, mỗi cái d_model → d_model, không tham số nào khác"""
    t.seed(0)
    m = need(user, "MultiHeadAttention")(D, H)
    for name in NAMES:
        assert isinstance(getattr(m, name, None), nn.Linear), f"Chưa có thuộc tính {name} là một nn.Linear."
    shapes = {n: tuple(p.shape) for n, p in m.named_parameters()}
    want = {f"{name}.{p}": ((D, D) if p == "weight" else (D,)) for name in NAMES for p in ["weight", "bias"]}
    assert shapes == want, f"Tham số của MultiHeadAttention({D}, {H}) là {sorted(shapes)}; cần đúng 8 tensor w_q/w_k/w_v/w_o .weight ({D}, {D}) và .bias ({D},)."


def test_self_attention(user, ref):
    """Self-attention (q = k = v): shape (B, T, d_model), giá trị khớp lời giải chuẩn"""
    m, r = _pair(user, ref, seed=1)
    x = torch.randn(2, 5, D, generator=_g(2))
    out = m(x, x, x)
    t.shape(out, (2, 5, D), what="MultiHeadAttention(x, x, x) với x (2, 5, 16)")
    t.close(out, r(x, x, x), what="đầu ra self-attention (kiểm hệ số scale và cách tách, ghép head)")


def test_cross_attention(user, ref):
    """Cross-attention: q dài 3, k và v dài 7 và khác nhau, ra (B, 3, d_model)"""
    m, r = _pair(user, ref, seed=3)
    q, k, v = _qkv(4, 3, 7)
    out = m(q, k, v)
    t.shape(out, (2, 3, D), what="đầu ra với q (2, 3, 16), k và v (2, 7, 16)")
    t.close(out, r(q, k, v), what="đầu ra cross-attention (mỗi phép chiếu áp vào đầu vào nào?)")


def test_padding_mask(user, ref):
    """Mask padding (B, 1, 1, Tk): key bị che có trọng số 0, đổi nó không đổi kết quả"""
    m, r = _pair(user, ref, seed=5)
    q, k, v = _qkv(6, 3, 7)
    mask = torch.ones(2, 1, 1, 7, dtype=torch.bool)
    mask[1, ..., 4:] = False
    out = m(q, k, v, mask)
    assert np.isfinite(t.array(out)).all(), "Có NaN/inf khi dùng mask: hàng nào đang bị che toàn bộ?"
    t.close(out, r(q, k, v, mask), what="đầu ra có mask padding (True nghĩa là được nhìn hay bị che?)")
    g = _g(7)
    k2, v2 = k.clone(), v.clone()
    k2[1, 4:] = 50 * torch.randn(3, D, generator=g)
    v2[1, 4:] = 50 * torch.randn(3, D, generator=g)
    t.close(m(q, k2, v2, mask), out, what="đầu ra khi đổi các key/value đã bị che (chúng phải có trọng số đúng bằng 0)")


def test_causal_mask(user, ref):
    """Mask causal (T, T): đầu ra ở vị trí t không phụ thuộc các vị trí sau t"""
    m, r = _pair(user, ref, seed=8)
    x = torch.randn(2, 6, D, generator=_g(9))
    mask = torch.tril(torch.ones(6, 6, dtype=torch.bool))
    out = m(x, x, x, mask)
    t.close(out, r(x, x, x, mask), what="đầu ra với mask causal (6, 6)")
    x2 = x.clone()
    x2[:, 3:] += 5.0
    t.close(m(x2, x2, x2, mask)[:, :3], out[:, :3], what="đầu ra ở 3 vị trí đầu khi chỉ đổi các vị trí sau")


def test_heads(user, ref):
    """Chạy với số head khác (d_model 24 với 6 head và 1 head); d_model không chia hết thì ValueError"""
    for h, seed in [(6, 10), (1, 11)]:
        m, r = _pair(user, ref, d=24, h=h, seed=seed)
        x = torch.randn(3, 4, 24, generator=_g(seed)) * 3
        t.close(m(x, x, x), r(x, x, x), what=f"đầu ra với d_model = 24, {h} head")
    try:
        need(user, "MultiHeadAttention")(10, 3)
    except ValueError:
        return
    raise AssertionError("MultiHeadAttention(10, 3) phải raise ValueError: 10 không chia hết cho 3.")


def test_no_builtin(user, ref):
    """Tự tính attention theo Eq. 1, không gọi F.scaled_dot_product_attention"""
    m, _ = _pair(user, ref, seed=12)
    x = torch.randn(1, 4, D, generator=_g(13))
    original = getattr(F, "scaled_dot_product_attention", None)
    if original is None:
        return
    calls = []

    def spy(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    F.scaled_dot_product_attention = spy
    try:
        m(x, x, x)
    finally:
        F.scaled_dot_product_attention = original
    assert not calls, "Bài này là tự viết công thức attention (Eq. 1): đừng gọi F.scaled_dot_product_attention."
