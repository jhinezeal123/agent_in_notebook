V, BS, C, H, NL = 11, 8, 16, 4, 2


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _tokens(shape, seed):
    return torch.randint(0, V, shape, generator=_g(seed))


def _pair(user, ref, seed=0, n_layer=NL):
    t.seed(seed)
    m = need(user, "GPT")(V, BS, C, H, n_layer)
    t.seed(seed + 1)
    r = ref["GPT"](V, BS, C, H, n_layer)
    t.load_into(m, r)
    return m, r


def _run(m, idx, targets=None):
    out = m(idx) if targets is None else m(idx, targets)
    assert isinstance(out, tuple) and len(out) == 2, "forward phải trả về một cặp (logits, loss)."
    return out


def test_structure(user, ref):
    """Đúng các thuộc tính tok_emb, pos_emb, blocks, ln_f, head và Block (ln1, attn, ln2, mlp), tên tham số khớp đề"""
    t.seed(0)
    m = need(user, "GPT")(V, BS, C, H, 3)
    assert getattr(m, "block_size", None) == BS, "GPT cần thuộc tính block_size (bằng đối số block_size)."
    emb = getattr(m, "tok_emb", None)
    assert isinstance(emb, nn.Embedding) and tuple(emb.weight.shape) == (V, C), f"tok_emb phải là nn.Embedding(vocab_size, n_embd) = nn.Embedding({V}, {C})."
    emb = getattr(m, "pos_emb", None)
    assert isinstance(emb, nn.Embedding) and tuple(emb.weight.shape) == (BS, C), f"pos_emb phải là nn.Embedding(block_size, n_embd) = nn.Embedding({BS}, {C}): mỗi vị trí một vector học được."
    blocks = getattr(m, "blocks", None)
    assert isinstance(blocks, (nn.ModuleList, nn.Sequential)), "blocks phải là nn.ModuleList (hoặc nn.Sequential): nn.Module mới thấy tham số của từng khối."
    assert len(blocks) == 3, f"blocks có {len(blocks)} khối, cần n_layer = 3."
    block_cls, attn_cls = need(user, "Block"), need(user, "CausalSelfAttention")
    for i, b in enumerate(blocks):
        assert isinstance(b, block_cls), f"blocks[{i}] phải là một Block (của bạn)."
        for name in ["ln1", "ln2"]:
            ln = getattr(b, name, None)
            assert isinstance(ln, nn.LayerNorm) and tuple(ln.normalized_shape) == (C,), f"Block.{name} phải là nn.LayerNorm(n_embd)."
        assert isinstance(getattr(b, "attn", None), attn_cls), "Block.attn phải là một CausalSelfAttention của bạn (bài causal-attention): dùng lại, đừng viết attention mới."
        mlp = getattr(b, "mlp", None)
        ok = isinstance(mlp, nn.Sequential) and len(mlp) == 3 and isinstance(mlp[0], nn.Linear) and isinstance(mlp[1], nn.GELU) and isinstance(mlp[2], nn.Linear)
        assert ok, "Block.mlp phải là một nn.Sequential gồm đúng ba lớp: nn.Linear, nn.GELU, nn.Linear."
        assert tuple(mlp[0].weight.shape) == (4 * C, C) and tuple(mlp[2].weight.shape) == (C, 4 * C), "mlp phải nở n_embd → 4·n_embd rồi thu về n_embd."
    ln = getattr(m, "ln_f", None)
    assert isinstance(ln, nn.LayerNorm) and tuple(ln.normalized_shape) == (C,), "ln_f phải là nn.LayerNorm(n_embd)."
    head = getattr(m, "head", None)
    assert isinstance(head, nn.Linear) and tuple(head.weight.shape) == (V, C) and head.bias is None, f"head phải là nn.Linear(n_embd, vocab_size, bias=False) = nn.Linear({C}, {V}, bias=False)."
    got = sorted(m.state_dict())
    want = sorted(ref["GPT"](V, BS, C, H, 3).state_dict())
    assert got == want, f"Tên tham số chưa khớp đề: thiếu {sorted(set(want) - set(got))[:4]}, thừa {sorted(set(got) - set(want))[:4]} (mọi thứ phải là tham số của đúng các thuộc tính trong đề)."


def test_logits(user, ref):
    """Không có targets: logits (B, T, vocab_size) khớp lời giải chuẩn và loss là None, với T = 1, 5 và block_size"""
    m, r = _pair(user, ref, seed=1)
    for T in [1, 5, BS]:
        idx = _tokens((3, T), 10 + T)
        logits, loss = _run(m, idx)
        t.shape(logits, (3, T, V), what=f"logits với idx (3, {T})")
        assert loss is None, "Không truyền targets thì loss phải là None."
        t.close(logits, r(idx)[0], tol=1e-4, what=f"logits với T = {T}")


def test_positions(user, ref):
    """Cùng một token lặp lại ở mọi vị trí vẫn cho logits khác nhau giữa các vị trí (đã cộng embedding vị trí)"""
    m, _ = _pair(user, ref, seed=2)
    idx = torch.full((1, 6), 3, dtype=torch.long)
    logits, _ = _run(m, idx)
    spread = float((logits[0, 5] - logits[0, 0]).abs().max())
    assert spread > 1e-3, "Cùng một token lặp lại mà logits ở vị trí 0 và vị trí 5 y hệt nhau: mô hình chưa biết token đứng ở đâu. Embedding của vị trí đã vào mô hình chưa?"


def test_loss_value(user, ref):
    """Có targets: loss là một số (0 chiều) bằng cross-entropy trung bình của dự đoán token kế, khớp lời giải chuẩn"""
    m, r = _pair(user, ref, seed=3)
    idx = _tokens((3, 7), 20)
    targets = _tokens((3, 7), 21)
    logits, loss = _run(m, idx, targets)
    assert loss is not None, "Có targets mà loss là None."
    assert isinstance(loss, torch.Tensor) and loss.ndim == 0, f"loss phải là tensor 0 chiều (một số), nhưng có shape {tuple(getattr(loss, 'shape', ()))}."
    want_logits, want_loss = r(idx, targets)
    t.close(logits, want_logits, tol=1e-4, what="logits khi có targets")
    got, want = float(loss), float(want_loss)
    if abs(got - want) > 1e-4:
        extra = ""
        if abs(got - float(F.cross_entropy(logits.reshape(-1, V), targets.reshape(-1)))) < 1e-4:
            extra = " Loss của bạn khớp với cách ghép đầu ra ở vị trí t với token đích ở chính vị trí t: dự đoán token kế thì đầu ra ở t phải nhìn tới token nào?"
        elif abs(got - 18 * want) < 1e-3 * max(1.0, want):
            extra = " Loss của bạn bằng đúng B·(T−1) lần giá trị cần: tổng hay trung bình?"
        raise AssertionError(f"loss = {got:.4f}, cần {want:.4f}.{extra}")


def test_target_shift(user, ref):
    """Loss không phụ thuộc token đích ở vị trí 0 (không đầu ra nào dự đoán nó) nhưng phụ thuộc token đích ở mọi vị trí từ 1 đến T − 1"""
    m, _ = _pair(user, ref, seed=4)
    T = 6
    idx = _tokens((3, T), 22)
    targets = _tokens((3, T), 23)
    base = float(_run(m, idx, targets)[1])
    for p in range(T):
        other = targets.clone()
        other[:, p] = (other[:, p] + 1) % V
        moved = float(_run(m, idx, other)[1])
        if p == 0:
            assert abs(moved - base) < 1e-6, "Đổi token đích ở vị trí 0 mà loss đổi: đầu ra nào dự đoán token ở vị trí 0? Không có đầu ra nào đứng trước nó."
        else:
            assert abs(moved - base) > 1e-6, f"Đổi token đích ở vị trí {p} mà loss không đổi: phải có một đầu ra dự đoán token ở vị trí {p}."


def test_loss_mean(user, ref):
    """Loss là trung bình (không phải tổng) trên mọi cặp: loss cả batch bằng trung bình loss từng mẫu; T = 2 (một cặp) vẫn đúng"""
    m, r = _pair(user, ref, seed=5)
    idx = _tokens((4, 5), 24)
    targets = _tokens((4, 5), 25)
    whole = float(_run(m, idx, targets)[1])
    singles = [float(_run(m, idx[i:i + 1], targets[i:i + 1])[1]) for i in range(4)]
    t.close(whole, sum(singles) / 4, tol=1e-5, what="loss của cả batch so với trung bình loss từng mẫu (trung bình trên B·(T−1) cặp)")
    idx2, targets2 = _tokens((2, 2), 26), _tokens((2, 2), 27)
    t.close(float(_run(m, idx2, targets2)[1]), float(r(idx2, targets2)[1]), tol=1e-4, what="loss với T = 2")


def test_no_future(user, ref):
    """Đổi token ở vị trí p thì logits ở các vị trí trước p không đổi; một đoạn đầu chạy riêng cho logits bằng phần đầu của cả chuỗi"""
    m, _ = _pair(user, ref, seed=6)
    idx = _tokens((2, BS), 28)
    logits = _run(m, idx)[0]
    assert np.isfinite(t.array(logits)).all(), "logits có NaN hoặc inf."
    for p in [1, 4, 7]:
        other = idx.clone()
        other[:, p] = (other[:, p] + 1) % V
        moved = _run(m, other)[0]
        t.close(moved[:, :p], logits[:, :p], tol=1e-4, what=f"logits ở {p} vị trí đầu khi chỉ đổi token ở vị trí {p} (có thứ gì đang trộn thông tin giữa các vị trí?)")
        assert float((moved[:, p] - logits[:, p]).abs().max()) > 1e-3, f"Đổi token ở vị trí {p} mà logits ở chính vị trí {p} không đổi."
    for k in [1, 3]:
        t.close(_run(m, idx[:, :k])[0], logits[:, :k], tol=1e-4, what=f"logits khi chỉ đưa {k} token đầu vào (vị trí phải đếm từ 0 theo đúng độ dài T của đầu vào)")


def test_gradients(user, ref):
    """Mọi tham số nhận gradient khớp lời giải chuẩn; embedding vị trí chỉ nhận gradient ở T vị trí đầu"""
    m, r = _pair(user, ref, seed=7)
    T = 5
    idx = _tokens((3, T), 29)
    targets = _tokens((3, T), 30)
    _run(m, idx, targets)[1].backward()
    r(idx, targets)[1].backward()
    want = dict(r.named_parameters())
    for name, p in m.named_parameters():
        assert p.grad is not None, f"Tham số {name} không nhận gradient: nó có nằm trên đường từ idx tới loss không?"
        t.close(p.grad, want[name].grad, tol=1e-5, what=f"gradient của {name}")
    g = m.pos_emb.weight.grad
    assert float(g[:T].abs().max()) > 0, "pos_emb không nhận gradient ở các vị trí 0..T-1."
    assert float(g[T:].abs().max()) == 0.0, f"pos_emb nhận gradient ở cả các vị trí từ {T} trở đi: embedding vị trí chỉ được lấy T hàng đầu, theo độ dài T của đầu vào."
