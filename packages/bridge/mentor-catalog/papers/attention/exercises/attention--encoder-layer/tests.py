D, H, DFF = 16, 4, 32


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _make(ns, name, *args, seed=0):
    t.seed(seed)
    return need(ns, name)(*args)


def _pair(user, ref, name, *args, seed=0):
    m = _make(user, name, *args, seed=seed)
    r = _make(ref, name, *args, seed=seed + 1)
    t.load_into(m, r)
    return m, r


def test_structure(user, ref):
    """FeedForward có w1, w2; EncoderLayer có self_attn, ffn, norm1, norm2, drop đúng loại và đúng tên tham số"""
    f = _make(user, "FeedForward", D, DFF)
    for name, shape in [("w1", (DFF, D)), ("w2", (D, DFF))]:
        layer = getattr(f, name, None)
        assert isinstance(layer, nn.Linear), f"FeedForward chưa có thuộc tính {name} là một nn.Linear."
        assert tuple(layer.weight.shape) == shape, f"FeedForward.{name} có weight {tuple(layer.weight.shape)}, cần {shape}."
    m = _make(user, "EncoderLayer", D, H, DFF, 0.3)
    assert isinstance(getattr(m, "self_attn", None), need(user, "MultiHeadAttention")), "self_attn phải là MultiHeadAttention của bạn (bài trước)."
    assert isinstance(getattr(m, "ffn", None), need(user, "FeedForward")), "ffn phải là một FeedForward."
    for name in ["norm1", "norm2"]:
        assert isinstance(getattr(m, name, None), nn.LayerNorm), f"Chưa có thuộc tính {name} là một nn.LayerNorm: mỗi sublayer có một LayerNorm riêng."
    drop = getattr(m, "drop", None)
    assert isinstance(drop, nn.Dropout) and drop.p == 0.3, "drop phải là nn.Dropout(dropout) với dropout truyền vào __init__."
    got = {n: tuple(p.shape) for n, p in m.named_parameters()}
    want = {n: tuple(p.shape) for n, p in ref["EncoderLayer"](D, H, DFF).named_parameters()}
    assert got == want, f"Tham số của EncoderLayer chưa khớp đề: thiếu {sorted(set(want) - set(got))}, thừa {sorted(set(got) - set(want))}."


def test_feed_forward(user, ref):
    """FeedForward: max(0, xW1 + b1)W2 + b2 áp riêng cho từng vị trí, khớp lời giải chuẩn"""
    m, r = _pair(user, ref, "FeedForward", D, DFF, seed=1)
    x = torch.randn(2, 5, D, generator=_g(2))
    out = m(x)
    t.shape(out, (2, 5, D), what="FeedForward với x (2, 5, 16)")
    t.close(out, r(x), what="đầu ra FeedForward (có hàm kích hoạt ở giữa hai Linear không?)")
    x2 = x.clone()
    x2[:, 3:] += 4.0
    t.close(m(x2)[:, :3], out[:, :3], what="đầu ra ở 3 vị trí đầu khi chỉ đổi các vị trí sau (FFN chạy riêng từng vị trí)")


def test_forward_eval(user, ref):
    """Ở chế độ eval, EncoderLayer ra (B, S, d_model) và khớp lời giải chuẩn (post-LN, hai residual)"""
    m, r = _pair(user, ref, "EncoderLayer", D, H, DFF, 0.1, seed=3)
    m.eval()
    r.eval()
    x = torch.randn(2, 6, D, generator=_g(4)) * 3
    out = m(x)
    t.shape(out, (2, 6, D), what="EncoderLayer với x (2, 6, 16)")
    t.close(out, r(x), tol=1e-4, what="đầu ra EncoderLayer (LayerNorm đứng trước hay sau phép cộng residual? sublayer nào có residual?)")


def test_post_ln(user, ref):
    """Post-LN: đầu ra mỗi vị trí vừa qua LayerNorm cuối nên có trung bình 0, phương sai 1"""
    m, _ = _pair(user, ref, "EncoderLayer", D, H, DFF, 0.1, seed=5)
    m.eval()
    x = torch.randn(2, 6, D, generator=_g(6)) * 3 + 2
    out = t.array(m(x))
    assert np.abs(out.mean(-1)).max() < 1e-4, "Trung bình theo d_model của đầu ra không về 0: phép cuối cùng của lớp encoder là gì?"
    assert np.abs(out.var(-1) - 1).max() < 1e-2, "Phương sai theo d_model của đầu ra không về 1: phép cuối cùng của lớp encoder là gì?"


def test_padding_mask(user, ref):
    """src_mask (B, 1, 1, S) được truyền vào self-attention: vị trí bị che không ảnh hưởng đầu ra"""
    m, r = _pair(user, ref, "EncoderLayer", D, H, DFF, 0.1, seed=7)
    m.eval()
    r.eval()
    x = torch.randn(2, 6, D, generator=_g(8))
    mask = torch.ones(2, 1, 1, 6, dtype=torch.bool)
    mask[1, ..., 4:] = False
    out = m(x, mask)
    t.close(out, r(x, mask), tol=1e-4, what="đầu ra EncoderLayer có src_mask")
    x2 = x.clone()
    x2[1, 4:] += 20.0
    out2 = m(x2, mask)
    t.close(out2[1, :4], out[1, :4], tol=1e-4, what="đầu ra ở 4 vị trí được nhìn khi chỉ đổi các vị trí bị che")
    t.close(out2[0], out[0], tol=1e-4, what="đầu ra của câu không bị che khi đổi câu khác")


def test_dropout(user, ref):
    """Dropout chỉ chạy ở chế độ train, và đặt trên đầu ra từng sublayer trước phép cộng residual"""
    x = torch.randn(2, 5, D, generator=_g(9)) * 2
    m, r = _pair(user, ref, "EncoderLayer", D, H, DFF, 1.0, seed=10)
    m.train()
    r.train()
    t.close(m(x), r.norm2(r.norm1(x)), tol=1e-4, what="đầu ra ở chế độ train với dropout = 1.0 (mọi đầu ra sublayer bị bỏ hết, chỉ còn đường residual: dropout đặt ở đâu?)")
    m2, _ = _pair(user, ref, "EncoderLayer", D, H, DFF, 0.5, seed=11)
    m2.train()
    t.seed(1)
    a = t.array(m2(x))
    t.seed(2)
    b = t.array(m2(x))
    assert not np.allclose(a, b), "Hai lần chạy ở chế độ train với seed khác nhau ra cùng kết quả: dropout chưa chạy."
    m2.eval()
    t.seed(1)
    a = t.array(m2(x))
    t.seed(2)
    b = t.array(m2(x))
    assert np.allclose(a, b), "Ở chế độ eval mà kết quả vẫn ngẫu nhiên: dropout phải tắt khi model.eval()."
