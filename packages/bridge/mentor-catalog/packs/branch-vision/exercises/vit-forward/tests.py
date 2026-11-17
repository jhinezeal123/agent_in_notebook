IMG, P, CIN, DIM, HEADS, DEPTH, NCLS = 8, 4, 3, 16, 2, 2, 5
NTOK = (IMG // P) ** 2  # 4 patch; chuỗi có 5 token kể cả cls


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _img(b, seed):
    return torch.randn((b, CIN, IMG, IMG), generator=_g(seed))


def _pair(user, ref, depth=DEPTH, seed=0):
    """Hai ViT (của bạn, chuẩn) cùng trọng số; cls_token và pos_embed của bản chuẩn được đặt lớn để thứ tự và vị trí có ý nghĩa."""
    t.seed(seed)
    m = need(user, "ViT")(IMG, P, CIN, DIM, depth, HEADS, NCLS)
    t.seed(seed + 1)
    q = ref["ViT"](IMG, P, CIN, DIM, depth, HEADS, NCLS)
    with torch.no_grad():
        q.cls_token.copy_(torch.randn(q.cls_token.shape, generator=_g(seed + 2)))
        q.pos_embed.copy_(torch.randn(q.pos_embed.shape, generator=_g(seed + 3)))
    t.load_into(m, q)
    return m, q


def _block_pair(user, ref, heads=HEADS, mlp_ratio=4, seed=0):
    t.seed(seed)
    m = need(user, "Block")(DIM, heads, mlp_ratio)
    t.seed(seed + 1)
    q = ref["Block"](DIM, heads, mlp_ratio)
    t.load_into(m, q)
    return m, q


def _need_attr(m, name):
    assert hasattr(m, name), f"Thiếu thuộc tính {name} (tên phải đúng như đề, để máy chấm chép được trọng số)."
    return getattr(m, name)


def test_structure(user, ref):
    """Đúng các thuộc tính patch_embed (PatchEmbed của bạn), cls_token (1, 1, D), pos_embed (1, N + 1, D), blocks, norm, head và Block (ln1, attn, ln2, mlp); tên tham số khớp đề"""
    m = need(user, "ViT")(IMG, P, CIN, DIM, 3, HEADS, NCLS)
    pe = getattr(m, "patch_embed", None)
    assert isinstance(pe, need(user, "PatchEmbed")), "patch_embed phải là một PatchEmbed của bạn (bài patch-embed): dùng lại, đừng viết lại."
    for name, shape, why in [("cls_token", (1, 1, DIM), "một token cho cả batch, sẽ được nhân ra theo batch lúc forward"),
                             ("pos_embed", (1, NTOK + 1, DIM), "một vector cho mỗi vị trí của chuỗi, và chuỗi có N patch cộng thêm token cls")]:
        p = getattr(m, name, None)
        assert isinstance(p, nn.Parameter), f"{name} phải là nn.Parameter (để optimizer học nó)."
        assert tuple(p.shape) == shape, f"{name} có shape {tuple(p.shape)}, cần {shape}: {why}."
    blocks = getattr(m, "blocks", None)
    assert isinstance(blocks, (nn.ModuleList, nn.Sequential)), "blocks phải là nn.ModuleList (hoặc nn.Sequential) để nn.Module thấy tham số của từng khối."
    assert len(blocks) == 3, f"blocks có {len(blocks)} khối, cần depth = 3."
    block_cls = need(user, "Block")
    for i, b in enumerate(blocks):
        assert isinstance(b, block_cls), f"blocks[{i}] phải là một Block (của bạn)."
        for name in ["ln1", "ln2"]:
            ln = _need_attr(b, name)
            assert isinstance(ln, nn.LayerNorm) and tuple(ln.normalized_shape) == (DIM,), f"Block.{name} phải là nn.LayerNorm(dim)."
        a = _need_attr(b, "attn")
        assert isinstance(a, nn.MultiheadAttention) and a.embed_dim == DIM and a.num_heads == HEADS, "Block.attn phải là nn.MultiheadAttention(dim, heads, batch_first=True)."
        assert a.batch_first, "Block.attn thiếu batch_first=True: không có nó, nn.MultiheadAttention hiểu trục đầu là chiều dài chuỗi chứ không phải batch."
        mlp = _need_attr(b, "mlp")
        ok = isinstance(mlp, nn.Sequential) and len(mlp) == 3 and isinstance(mlp[0], nn.Linear) and isinstance(mlp[1], nn.GELU) and isinstance(mlp[2], nn.Linear)
        assert ok, "Block.mlp phải là một nn.Sequential gồm đúng ba lớp: nn.Linear, nn.GELU, nn.Linear."
        assert tuple(mlp[0].weight.shape) == (4 * DIM, DIM) and tuple(mlp[2].weight.shape) == (DIM, 4 * DIM), "mlp phải nở dim → mlp_ratio·dim rồi thu về dim."
    ln = getattr(m, "norm", None)
    assert isinstance(ln, nn.LayerNorm) and tuple(ln.normalized_shape) == (DIM,), "norm phải là nn.LayerNorm(dim)."
    head = getattr(m, "head", None)
    assert isinstance(head, nn.Linear) and tuple(head.weight.shape) == (NCLS, DIM) and head.bias is not None, f"head phải là nn.Linear(dim, num_classes) = nn.Linear({DIM}, {NCLS})."
    got = sorted(m.state_dict())
    want = sorted(ref["ViT"](IMG, P, CIN, DIM, 3, HEADS, NCLS).state_dict())
    assert got == want, f"Tên tham số chưa khớp đề: thiếu {sorted(set(want) - set(got))[:4]}, thừa {sorted(set(got) - set(want))[:4]} (mọi thứ phải là tham số của đúng các thuộc tính trong đề)."


def test_block_values(user, ref):
    """Block: shape (B, T, dim) giữ nguyên và khớp lời giải chuẩn với 1, 2 và 4 head, với mlp_ratio 4 và 2 (attention theo trục chuỗi, không phải trục batch)"""
    for i, (heads, ratio) in enumerate([(1, 4), (2, 4), (4, 4), (2, 2)]):
        m, q = _block_pair(user, ref, heads, ratio, seed=i)
        x = torch.randn((3, 5, DIM), generator=_g(10 + i))
        y = m(x)
        t.shape(y, (3, 5, DIM), what=f"đầu ra của Block với x shape (3, 5, {DIM})")
        t.close(y, q(x), tol=1e-4, what=f"đầu ra của Block với heads = {heads}, mlp_ratio = {ratio}")


def test_block_residual(user, ref):
    """Block pre-LN: mỗi nhánh con được CỘNG vào x; tắt hai nhánh thì ra đúng x; tắt một nhánh thì ra x + nhánh còn lại tính từ LayerNorm của x"""
    x = torch.randn((2, 5, DIM), generator=_g(20))

    def off(m, attn, mlp):
        with torch.no_grad():
            if attn:
                m.attn.out_proj.weight.zero_()
                m.attn.out_proj.bias.zero_()
            if mlp:
                m.mlp[2].weight.zero_()
                m.mlp[2].bias.zero_()

    m, _ = _block_pair(user, ref, seed=3)
    off(m, True, True)
    t.close(m(x), x, tol=1e-5, what="Block khi cả nhánh attention lẫn nhánh MLP cho ra 0 (phải bằng đúng x: nhánh con được cộng vào đường residual)")
    m, _ = _block_pair(user, ref, seed=4)
    off(m, False, True)
    h = m.ln1(x)
    t.close(m(x), x + m.attn(h, h, h, need_weights=False)[0], tol=1e-5, what="Block khi chỉ còn nhánh attention (phải bằng x + Attn(LN1(x)))")
    m, _ = _block_pair(user, ref, seed=5)
    off(m, True, False)
    t.close(m(x), x + m.mlp(m.ln2(x)), tol=1e-5, what="Block khi chỉ còn nhánh MLP (phải bằng x + MLP(LN2(x)))")


def test_cls_readout(user, ref):
    """Với depth = 0 (không có khối nào) logits không phụ thuộc ảnh và bằng head(norm(cls_token + pos_embed[0])): cls ghép TRƯỚC patch, pos_embed cộng sau khi ghép, đọc token số 0"""
    m, _ = _pair(user, ref, depth=0, seed=6)
    x1, x2 = _img(2, 30), _img(2, 31)
    y1, y2 = m(x1), m(x2)
    t.shape(y1, (2, NCLS), what="logits với depth = 0 và batch 2")
    t.close(y1, y2, tol=1e-5, what="logits của hai ảnh khác nhau khi depth = 0 (không có attention thì token cls chẳng nhìn thấy ảnh nào: bạn đang đọc token nào?)")
    first = (m.cls_token + m.pos_embed[:, :1]).detach()
    one = m.head(m.norm(first))[:, 0]
    t.close(y1, one.expand(2, -1), tol=1e-5, what="logits với depth = 0 (phải là head(norm(cls_token + pos_embed ở vị trí 0)): cls ở đầu chuỗi và đã được cộng positional embedding)")


def test_forward_values(user, ref):
    """ViT đầy đủ cho logits (B, num_classes) khớp lời giải chuẩn với batch 1 và 3; mỗi ảnh trong batch cho cùng kết quả như khi đứng một mình"""
    m, q = _pair(user, ref, seed=7)
    for b in [1, 3]:
        x = _img(b, 40 + b)
        y = m(x)
        t.shape(y, (b, NCLS), what=f"logits với batch {b}")
        t.close(y, q(x), tol=1e-4, what=f"logits của ViT với batch {b} (cls, positional embedding, các khối, norm cuối, đọc token 0)")
    x = _img(3, 50)
    t.close(m(x)[1:2], m(x[1:2]), tol=1e-5, what="logits của ảnh thứ hai trong batch 3 so với khi đưa riêng nó (các ảnh trong batch không được trộn vào nhau)")
    m, q = _pair(user, ref, depth=1, seed=8)
    x = _img(2, 51)
    t.close(m(x), q(x), tol=1e-4, what="logits của ViT với depth = 1")


def test_gradients(user, ref):
    """Gradient: mọi tham số (cả cls_token, pos_embed, norm) đều nhận gradient, và gradient của cls_token, pos_embed, head khớp lời giải chuẩn"""
    m, q = _pair(user, ref, seed=9)
    x = _img(3, 60)
    w = torch.randn((3, NCLS), generator=_g(61))
    (m(x) * w).sum().backward()
    (q(x) * w).sum().backward()
    dead = [n for n, p in m.named_parameters() if p.grad is None]
    assert not dead, f"Các tham số này không nhận gradient (không nằm trên đường từ ảnh tới logits): {dead[:4]}. Có phần nào bạn tạo mà forward không dùng không?"
    t.close(m.cls_token.grad, q.cls_token.grad, tol=1e-4, what="gradient của cls_token")
    t.close(m.pos_embed.grad, q.pos_embed.grad, tol=1e-4, what="gradient của pos_embed")
    t.close(m.head.weight.grad, q.head.weight.grad, tol=1e-4, what="gradient của head.weight")
    t.close(m.patch_embed.proj.weight.grad, q.patch_embed.proj.weight.grad, tol=1e-4, what="gradient của patch_embed.proj.weight")
