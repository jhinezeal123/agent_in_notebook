def _g(seed):
    return torch.Generator().manual_seed(seed)


def _x(shape, seed):
    return torch.randn(shape, generator=_g(seed))


def _vit(user, p, img_size=28, seed=0):
    t.seed(seed)
    return need(user, "make_vit")(p, img_size) if img_size != 28 else need(user, "make_vit")(p)


def _n_params(m):
    return sum(p.numel() for p in m.parameters())


def test_config(user, ref):
    """make_vit(4) là ViT của bạn với dim 64, 3 khối, 4 head, ảnh xám 1 kênh (patch 4x4, một giá trị mỗi pixel), 10 lớp đầu ra"""
    net = _vit(user, 4)
    assert isinstance(net, need(user, "ViT")), "make_vit phải trả về một ViT của bạn (bài vit-forward), không phải mô hình khác."
    assert tuple(net.cls_token.shape) == (1, 1, 64), f"cls_token có shape {tuple(net.cls_token.shape)}, cần (1, 1, 64): dim của mô hình là 64."
    assert len(net.blocks) == 3, f"Có {len(net.blocks)} khối encoder, cần depth = 3."
    heads = net.blocks[0].attn.num_heads
    assert heads == 4, f"Khối attention có {heads} head, cần 4."
    proj = net.patch_embed.proj
    assert proj.in_channels == 1 and proj.kernel_size == (4, 4) and proj.out_channels == 64, f"patch_embed.proj là conv {proj.in_channels} -> {proj.out_channels} kênh, kernel {proj.kernel_size}: MNIST là ảnh xám (1 kênh), patch 4x4, dim 64."
    assert net.head.out_features == 10, f"head cho {net.head.out_features} lớp, cần 10."


def test_tokens_and_pos_embed(user, ref):
    """Với patch 2, 4, 7, 14 trên ảnh 28x28 (và patch 8 trên ảnh 32x32): pos_embed có N + 1 hàng với N = (ảnh / patch)², logits ra (B, 10)"""
    for p, img in [(2, 28), (4, 28), (7, 28), (14, 28), (8, 32)]:
        net = _vit(user, p, img)
        n = (img // p) ** 2
        t.shape(net.pos_embed, (1, n + 1, 64), what=f"pos_embed của make_vit({p}, img_size={img}) (N = {n} patch cộng cls)")
        net.eval()
        with torch.no_grad():
            t.shape(net(_x((2, 1, img, img), p)), (2, 10), what=f"logits của make_vit({p}, img_size={img}) với ảnh (2, 1, {img}, {img})")


def test_img_size_used(user, ref):
    """make_vit dùng img_size được truyền vào (ảnh 32x32 thì lưới patch khác ảnh 28x28), không cố định 28"""
    net28, net32 = _vit(user, 4), _vit(user, 4, 32)
    assert net28.pos_embed.shape[1] == 50 and net32.pos_embed.shape[1] == 65, f"pos_embed có {net28.pos_embed.shape[1]} hàng cho ảnh 28 và {net32.pos_embed.shape[1]} hàng cho ảnh 32, cần 50 và 65: img_size có được truyền cho ViT không?"
    assert _n_params(net32) > _n_params(net28), "Ảnh 32x32 với patch 4 có nhiều token hơn nên pos_embed lớn hơn: số tham số phải nhiều hơn ảnh 28x28."


def test_not_divisible(user, ref):
    """img_size không chia hết cho patch_size thì make_vit raise ValueError ngay (patch 5 và 8 trên ảnh 28x28)"""
    for p in (5, 8):
        try:
            need(user, "make_vit")(p)
        except ValueError:
            continue
        except Exception as e:
            raise AssertionError(f"make_vit({p}) với ảnh 28x28 phải raise ValueError, nhưng raise {type(e).__name__}.")
        raise AssertionError(f"make_vit({p}) với ảnh 28x28 không báo lỗi: 28 không chia hết cho {p}, nên lưới patch không cắt vừa ảnh.")


def test_matches_reference(user, ref):
    """make_vit(4) và make_vit(7) cùng số tham số và cho cùng logits với bản chuẩn khi cùng trọng số"""
    for p in (4, 7):
        m = _vit(user, p)
        t.seed(1)
        q = ref["make_vit"](p)
        t.load_into(m, q)
        assert _n_params(m) == _n_params(q), f"make_vit({p}) có {_n_params(m):,} tham số, bản chuẩn có {_n_params(q):,}."
        m.eval()
        q.eval()
        x = _x((3, 1, 28, 28), 20 + p)
        with torch.no_grad():
            t.close(m(x), q(x), tol=1e-4, what=f"logits của make_vit({p})")


def test_resize_shape_and_cls(user, ref):
    """resize_pos_embed ra shape (1, 1 + new², D) cho lưới lớn lên và nhỏ đi; hàng cls (hàng 0) giữ nguyên từng số"""
    f = need(user, "resize_pos_embed")
    for old, new, dim in [(7, 14, 8), (14, 7, 16), (4, 6, 5)]:
        pe = _x((1, 1 + old * old, dim), old + new)
        before = pe.clone()
        out = f(pe, old, new)
        t.shape(out, (1, 1 + new * new, dim), what=f"kết quả với lưới {old} -> {new}, D = {dim}")
        t.close(out[:, 0], before[:, 0], tol=1e-7, what="hàng cls (token cls không nằm trên lưới ảnh, không được đụng vào)")
        t.close(pe, before, tol=1e-9, what="pos_embed đầu vào (không được sửa tại chỗ)")


def test_resize_values(user, ref):
    """Giá trị nội suy khớp bản chuẩn (bicubic, align_corners=False) khi lưới lớn lên (7 -> 14, 4 -> 6) và nhỏ đi (14 -> 7), và giữ nguyên khi lưới không đổi"""
    f = need(user, "resize_pos_embed")
    for old, new, dim in [(7, 14, 8), (4, 6, 5), (14, 7, 16)]:
        pe = _x((1, 1 + old * old, dim), 3 * old + new)
        t.close(f(pe, old, new), ref["resize_pos_embed"](pe, old, new), tol=1e-5, what=f"pos_embed nội suy từ lưới {old} lên {new}")
    pe = _x((1, 1 + 25, 6), 77)
    t.close(f(pe, 5, 5), pe, tol=1e-5, what="kết quả khi new_grid == old_grid (phải giữ nguyên)")


def test_resize_is_2d(user, ref):
    """Nội suy theo hai chiều không gian: nếu pos_embed chỉ đổi theo hàng của lưới thì sau khi nội suy vẫn không đổi theo cột; nếu chỉ đổi theo cột thì không đổi theo hàng"""
    f = need(user, "resize_pos_embed")
    old, new, dim = 7, 12, 4
    rows = torch.arange(old, dtype=torch.float32).view(old, 1, 1).expand(old, old, dim)
    cols = torch.arange(old, dtype=torch.float32).view(1, old, 1).expand(old, old, dim)
    cls_row = torch.zeros(1, 1, dim)
    for name, grid, axis in [("hàng", rows, 1), ("cột", cols, 0)]:
        pe = torch.cat([cls_row, grid.reshape(1, old * old, dim)], dim=1)
        out = f(pe, old, new)[:, 1:].reshape(new, new, dim)
        spread = float((out.max(dim=axis).values - out.min(dim=axis).values).max())
        assert spread < 1e-4, f"pos_embed chỉ đổi theo {name} của lưới mà sau nội suy vẫn còn đổi theo chiều kia (lệch {spread:.2e}): lưới 2D bị trộn lẫn các chiều. Bạn đã đưa lưới về đúng dạng (N, kênh, hàng, cột) trước khi nội suy chưa?"
