V, D, H, DFF, NL, MAXLEN = 13, 16, 4, 32, 2, 20


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _make(ns, dropout=0.1, n_layers=NL, seed=0):
    t.seed(seed)
    return need(ns, "Transformer")(V, d_model=D, n_heads=H, d_ff=DFF, n_layers=n_layers, dropout=dropout, max_len=MAXLEN)


def _pair(user, ref, dropout=0.1, seed=0):
    m = _make(user, dropout, seed=seed)
    r = _make(ref, dropout, seed=seed + 1)
    t.load_into(m, r)
    return m, r


def _data(ref, seed, b=2, s=6, tl=5):
    g = _g(seed)
    src = torch.randint(3, V, (b, s), generator=g)
    tgt = torch.randint(3, V, (b, tl), generator=g)
    tgt[:, 0] = ref["BOS"]
    return src, tgt


def test_structure(user, ref):
    """Đúng các thuộc tính embed, drop, enc_layers, dec_layers, out; mặc định d_model = 64, n_layers = 2"""
    m = _make(user, 0.3, n_layers=3)
    assert isinstance(getattr(m, "embed", None), need(user, "PositionalEmbedding")), "embed phải là một PositionalEmbedding (của bạn, bài trước)."
    drop = getattr(m, "drop", None)
    assert isinstance(drop, nn.Dropout) and drop.p == 0.3, "drop phải là nn.Dropout(dropout) với dropout truyền vào __init__."
    for name, cls in [("enc_layers", "EncoderLayer"), ("dec_layers", "DecoderLayer")]:
        layers = getattr(m, name, None)
        assert isinstance(layers, nn.ModuleList), f"{name} phải là một nn.ModuleList (nn.Module mới thấy tham số của từng lớp)."
        assert len(layers) == 3, f"{name} có {len(layers)} lớp, cần n_layers = 3."
        assert all(isinstance(layer, need(user, cls)) for layer in layers), f"Mỗi phần tử của {name} phải là một {cls} của bạn."
    got = sorted(m.state_dict())
    want = sorted(_make(ref, 0.3, n_layers=3).state_dict())
    assert got == want, f"Tên tham số chưa khớp đề: thiếu {sorted(set(want) - set(got))[:4]}, thừa {sorted(set(got) - set(want))[:4]}."
    t.seed(0)
    small = need(user, "Transformer")(V)
    assert len(small.enc_layers) == 2 and tuple(small.embed.embed.weight.shape) == (V, 64), "Giá trị mặc định chưa đúng: d_model = 64, n_layers = 2."


def test_weight_tying(user, ref):
    """out là nn.Linear không bias và out.weight chính là embed.embed.weight (§3.4): cùng một tham số"""
    m = _make(user)
    out = getattr(m, "out", None)
    assert isinstance(out, nn.Linear) and out.bias is None, "out phải là nn.Linear(d_model, vocab_size, bias=False)."
    assert out.weight is m.embed.embed.weight, "out.weight chưa phải chính là embed.embed.weight: gán cho nhau (không chép giá trị) thì hai bên mới cùng một tham số."
    r = _make(ref)
    n_user = sum(p.numel() for p in m.parameters())
    n_ref = sum(p.numel() for p in r.parameters())
    assert n_user == n_ref, f"Tổng số tham số là {n_user}, cần {n_ref} (tham số dùng chung chỉ đếm một lần)."


def test_forward_eval(user, ref):
    """Ở chế độ eval: logits (B, T, vocab_size) khớp lời giải chuẩn, với S và T khác nhau"""
    m, r = _pair(user, ref, seed=1)
    m.eval()
    r.eval()
    src, tgt = _data(ref, 2)
    out = m(src, tgt)
    t.shape(out, (2, 5, V), what="logits với src (2, 6) và tgt_in (2, 5)")
    t.close(out, r(src, tgt), tol=1e-4, what="logits (embedding dùng chung, chồng encoder rồi chồng decoder với memory, rồi out)")


def test_causal(user, ref):
    """Logits ở vị trí t của chuỗi đích không phụ thuộc tgt_in ở các vị trí sau t"""
    m, _ = _pair(user, ref, seed=3)
    m.eval()
    src, tgt = _data(ref, 4, tl=6)
    out = m(src, tgt)
    tgt2 = tgt.clone()
    tgt2[:, 3:] = torch.randint(3, V, (2, 3), generator=_g(5))
    t.close(m(src, tgt2)[:, :3], out[:, :3], tol=1e-4, what="logits ở 3 vị trí đầu khi chỉ đổi tgt_in ở các vị trí sau (tgt_mask đã vào decoder chưa?)")


def test_src_padding(user, ref):
    """Thêm PAD vào cuối câu nguồn không đổi logits: src_mask phải vào cả encoder lẫn cross-attention"""
    m, _ = _pair(user, ref, seed=6)
    m.eval()
    src, tgt = _data(ref, 7, b=1, s=4, tl=5)
    padded = torch.cat([src, torch.full((1, 3), ref["PAD"], dtype=torch.long)], dim=1)
    want = m(src, tgt)
    t.close(m(padded, tgt), want, tol=1e-4, what="logits khi câu nguồn có thêm 3 PAD ở cuối (self-attention của encoder và cross-attention có đều bỏ qua PAD không?)")


def test_gradients(user, ref):
    """Mọi tham số nhận gradient: encoder, decoder, cross-attention, và embedding dùng chung"""
    m, _ = _pair(user, ref, dropout=0.0, seed=8)
    m.train()
    src, tgt = _data(ref, 9)
    out = m(src, tgt)
    w = torch.randn(out.shape, generator=_g(10))
    (out * w).sum().backward()
    missing = [n for n, p in m.named_parameters() if p.grad is None]
    assert not missing, f"Các tham số này không nhận gradient: {missing[:4]}. Chúng có nằm trên đường tính logits không?"


def test_dropout(user, ref):
    """Dropout chạy ở chế độ train và tắt ở chế độ eval"""
    m, _ = _pair(user, ref, dropout=0.5, seed=11)
    src, tgt = _data(ref, 12)
    m.train()
    t.seed(1)
    a = t.array(m(src, tgt))
    t.seed(2)
    b = t.array(m(src, tgt))
    assert not np.allclose(a, b), "Hai lần chạy ở chế độ train với seed khác nhau ra cùng kết quả: dropout chưa chạy."
    m.eval()
    t.seed(1)
    a = t.array(m(src, tgt))
    t.seed(2)
    b = t.array(m(src, tgt))
    assert np.allclose(a, b), "Ở chế độ eval mà kết quả vẫn ngẫu nhiên: dropout phải tắt khi model.eval()."
