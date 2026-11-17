D, H, DFF = 16, 4, 32
T, S = 5, 7


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _make(ns, *args, seed=0):
    t.seed(seed)
    return need(ns, "DecoderLayer")(*args)


def _pair(user, ref, dropout=0.1, seed=0):
    m = _make(user, D, H, DFF, dropout, seed=seed)
    r = _make(ref, D, H, DFF, dropout, seed=seed + 1)
    t.load_into(m, r)
    return m, r


def _inputs(seed, b=2):
    g = _g(seed)
    return torch.randn(b, T, D, generator=g) * 2, torch.randn(b, S, D, generator=g) * 2


def test_structure(user, ref):
    """DecoderLayer có self_attn, cross_attn (hai attention riêng), ffn, norm1-3, drop đúng loại và đúng tên"""
    m = _make(user, D, H, DFF, 0.3)
    attn = need(user, "MultiHeadAttention")
    for name in ["self_attn", "cross_attn"]:
        assert isinstance(getattr(m, name, None), attn), f"Chưa có thuộc tính {name} là một MultiHeadAttention (của bạn, bài trước)."
    assert m.self_attn is not m.cross_attn, "self_attn và cross_attn là cùng một đối tượng: hai sublayer cần hai bộ trọng số riêng."
    assert isinstance(getattr(m, "ffn", None), need(user, "FeedForward")), "ffn phải là một FeedForward (bài encoder)."
    for name in ["norm1", "norm2", "norm3"]:
        assert isinstance(getattr(m, name, None), nn.LayerNorm), f"Chưa có thuộc tính {name} là một nn.LayerNorm: mỗi sublayer có một LayerNorm riêng."
    drop = getattr(m, "drop", None)
    assert isinstance(drop, nn.Dropout) and drop.p == 0.3, "drop phải là nn.Dropout(dropout) với dropout truyền vào __init__."
    got = {n: tuple(p.shape) for n, p in m.named_parameters()}
    want = {n: tuple(p.shape) for n, p in ref["DecoderLayer"](D, H, DFF).named_parameters()}
    assert got == want, f"Tham số của DecoderLayer chưa khớp đề: thiếu {sorted(set(want) - set(got))}, thừa {sorted(set(got) - set(want))}."


def test_forward_eval(user, ref):
    """Ở chế độ eval, không mask: ra (B, T, d_model) và khớp lời giải chuẩn, với T và S khác nhau"""
    m, r = _pair(user, ref, seed=1)
    m.eval()
    r.eval()
    x, memory = _inputs(2)
    out = m(x, memory)
    t.shape(out, (2, T, D), what=f"DecoderLayer với x (2, {T}, 16) và memory (2, {S}, 16)")
    t.close(out, r(x, memory), tol=1e-4, what="đầu ra DecoderLayer (thứ tự ba sublayer, hai residual còn lại, LayerNorm sau mỗi phép cộng)")


def test_depends_on_memory(user, ref):
    """Đầu ra phụ thuộc vào memory đúng như lời giải chuẩn: cross-attention lấy k, v từ memory, q từ decoder"""
    m, r = _pair(user, ref, seed=3)
    m.eval()
    r.eval()
    x, memory = _inputs(4)
    other = memory + 3 * torch.randn(2, S, D, generator=_g(5))
    a, b = m(x, memory), m(x, other)
    assert not np.allclose(t.array(a), t.array(b), atol=1e-4), "Đổi memory mà đầu ra không đổi: cross-attention đang nhìn vào đâu?"
    t.close(b, r(x, other), tol=1e-4, what="đầu ra khi đổi memory")


def test_causal_mask(user, ref):
    """tgt_mask causal (T, T): đầu ra ở vị trí t không phụ thuộc các vị trí sau t của chuỗi đích"""
    m, r = _pair(user, ref, seed=6)
    m.eval()
    r.eval()
    x, memory = _inputs(7)
    causal = torch.tril(torch.ones(T, T, dtype=torch.bool))
    out = m(x, memory, tgt_mask=causal)
    t.close(out, r(x, memory, tgt_mask=causal), tol=1e-4, what="đầu ra với tgt_mask causal")
    x2 = x.clone()
    x2[:, 3:] += 5.0
    t.close(m(x2, memory, tgt_mask=causal)[:, :3], out[:, :3], tol=1e-4, what="đầu ra ở 3 vị trí đầu khi chỉ đổi các vị trí sau của chuỗi đích (mask causal dùng ở sublayer nào?)")


def test_memory_mask(user, ref):
    """memory_mask (B, 1, 1, S) chỉ dùng ở cross-attention: đổi các vị trí memory bị che không đổi đầu ra"""
    m, r = _pair(user, ref, seed=8)
    m.eval()
    r.eval()
    x, memory = _inputs(9)
    mask = torch.ones(2, 1, 1, S, dtype=torch.bool)
    mask[1, ..., 4:] = False
    out = m(x, memory, memory_mask=mask)
    t.close(out, r(x, memory, memory_mask=mask), tol=1e-4, what="đầu ra với memory_mask")
    memory2 = memory.clone()
    memory2[1, 4:] += 30.0
    t.close(m(x, memory2, memory_mask=mask), out, tol=1e-4, what="đầu ra khi đổi các vị trí memory bị che (memory_mask phải có tác dụng ở cross-attention)")


def test_both_masks(user, ref):
    """Dùng cùng lúc tgt_mask causal và memory_mask padding: mỗi mask đúng sublayer của nó"""
    m, r = _pair(user, ref, seed=10)
    m.eval()
    r.eval()
    x, memory = _inputs(11)
    causal = torch.tril(torch.ones(T, T, dtype=torch.bool))
    mem_mask = torch.ones(2, 1, 1, S, dtype=torch.bool)
    mem_mask[0, ..., 5:] = False
    t.close(m(x, memory, causal, mem_mask), r(x, memory, causal, mem_mask), tol=1e-4, what="đầu ra với cả hai mask (truyền theo thứ tự tgt_mask, memory_mask)")


def test_dropout(user, ref):
    """Dropout chỉ chạy ở chế độ train và đặt trên đầu ra từng sublayer, trước phép cộng residual"""
    x, memory = _inputs(12)
    m, r = _pair(user, ref, dropout=1.0, seed=13)
    m.train()
    r.train()
    t.close(m(x, memory), r.norm3(r.norm2(r.norm1(x))), tol=1e-4, what="đầu ra ở chế độ train với dropout = 1.0 (cả ba đầu ra sublayer bị bỏ, chỉ còn đường residual: dropout đặt ở đâu?)")
    m2, _ = _pair(user, ref, dropout=0.5, seed=14)
    m2.train()
    t.seed(1)
    a = t.array(m2(x, memory))
    t.seed(2)
    b = t.array(m2(x, memory))
    assert not np.allclose(a, b), "Hai lần chạy ở chế độ train với seed khác nhau ra cùng kết quả: dropout chưa chạy."
    m2.eval()
    t.seed(1)
    a = t.array(m2(x, memory))
    t.seed(2)
    b = t.array(m2(x, memory))
    assert np.allclose(a, b), "Ở chế độ eval mà kết quả vẫn ngẫu nhiên: dropout phải tắt khi model.eval()."
