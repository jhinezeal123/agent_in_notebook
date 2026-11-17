def _g(seed):
    return torch.Generator().manual_seed(seed)


def _img(shape, seed):
    return torch.randn(shape, generator=_g(seed))


def _oracle(x, p):
    """Cắt bằng vòng lặp (chậm nhưng hiển nhiên đúng): patch quét hàng trước cột, mỗi patch duỗi theo (C, p, p)."""
    B, C, H, W = x.shape
    return torch.stack([
        torch.stack([x[b, :, r * p:(r + 1) * p, s * p:(s + 1) * p].reshape(-1) for r in range(H // p) for s in range(W // p)])
        for b in range(B)
    ])


def _embed_pair(user, ref, in_ch, dim, p, seed=0):
    t.seed(seed)
    m = need(user, "PatchEmbed")(in_ch, dim, p)
    t.seed(seed + 1)
    q = ref["PatchEmbed"](in_ch, dim, p)
    t.load_into(m, q)
    return m, q


def test_patchify_shape(user, ref):
    """patchify cho shape (B, N, C·p·p) với N = (H/p)·(W/p): ảnh vuông, ảnh chữ nhật, batch 1, một kênh và chỉ một patch"""
    f = need(user, "patchify")
    for i, (shape, p) in enumerate([((2, 3, 8, 12), 4), ((1, 1, 6, 6), 3), ((3, 2, 4, 8), 2), ((2, 3, 6, 6), 6), ((1, 4, 10, 5), 5)]):
        B, C, H, W = shape
        y = f(_img(shape, i), p)
        t.shape(y, (B, (H // p) * (W // p), C * p * p), what=f"patchify với x shape {shape}, p = {p}")


def test_patch_grid_order(user, ref):
    """Thứ tự các patch: hàng trước cột (patch 0 ở góc trên-trái, patch 1 ngay bên phải nó)"""
    f = need(user, "patchify")
    p, hp, wp = 3, 2, 3
    x = torch.zeros(2, 1, hp * p, wp * p)
    for b in range(2):
        for r in range(hp):
            for s in range(wp):
                x[b, 0, r * p:(r + 1) * p, s * p:(s + 1) * p] = b * 100 + r * 10 + s
    y = f(x, p)
    t.shape(y, (2, hp * wp, p * p), what="patchify với ảnh 6×9 một kênh, p = 3")
    want = torch.tensor([[[b * 100 + (k // wp) * 10 + k % wp] * (p * p) for k in range(hp * wp)] for b in range(2)], dtype=torch.float32)
    t.close(y, want, tol=1e-6, what="patchify với mỗi ô của lưới 2×3 mang một giá trị riêng (patch k phải là ô hàng k // 3, cột k % 3: quét hàng trước cột)")


def test_within_patch_order(user, ref):
    """Thứ tự bên trong một patch: duỗi theo (C, p, p) (kênh ngoài cùng, rồi hàng, rồi cột), như patch.reshape(-1)"""
    f = need(user, "patchify")
    for B, C, p in [(1, 3, 4), (2, 2, 3)]:
        x = torch.arange(B * C * p * p, dtype=torch.float32).view(B, C, p, p)
        y = f(x, p)
        t.shape(y, (B, 1, C * p * p), what=f"patchify với ảnh đúng bằng một patch (x shape {tuple(x.shape)}, p = {p})")
        t.close(y, x.reshape(B, 1, C * p * p), tol=1e-6, what=f"vector của patch duy nhất với x shape {tuple(x.shape)} (cần thứ tự (C, p, p): kênh, rồi hàng, rồi cột)")


def test_patchify_general(user, ref):
    """patchify khớp phép cắt bằng vòng lặp trên ảnh ngẫu nhiên nhiều kênh, chữ nhật; không sửa đầu vào"""
    f = need(user, "patchify")
    for i, (shape, p) in enumerate([((2, 3, 8, 12), 4), ((1, 2, 6, 9), 3), ((3, 1, 10, 5), 5), ((2, 4, 6, 6), 2)]):
        x = _img(shape, 10 + i)
        keep = x.clone()
        t.close(f(x, p), _oracle(x, p), tol=1e-6, what=f"patchify với x shape {shape}, p = {p}")
        assert torch.equal(x, keep), "patchify đã sửa đầu vào x tại chỗ."


def test_not_divisible(user, ref):
    """H hoặc W không chia hết cho p thì patchify và PatchEmbed đều raise ValueError (không âm thầm cắt bỏ phần dư)"""
    f = need(user, "patchify")
    m = need(user, "PatchEmbed")(3, 8, 4)
    for shape in [(1, 3, 8, 10), (1, 3, 9, 8), (2, 3, 7, 7)]:
        x = _img(shape, 20)
        for name, fn in [("patchify", lambda z: f(z, 4)), ("PatchEmbed", m)]:
            try:
                fn(x)
            except ValueError:
                continue
            raise AssertionError(f"{name} với ảnh shape {shape} và patch 4 không raise ValueError: nếu lặng lẽ bỏ phần dư thì ta mất pixel mà không biết.")
    assert f(_img((1, 3, 8, 12), 21), 4).shape[1] == 6, "Ảnh 8×12 chia hết cho 4 mà patchify vẫn lỗi hoặc cho sai số patch."


def test_embed_structure(user, ref):
    """PatchEmbed có patch_size và proj là đúng một nn.Conv2d(in_ch, embed_dim, kernel p, stride p, không padding, có bias); tên tham số khớp đề"""
    m = need(user, "PatchEmbed")(3, 16, 4)
    assert getattr(m, "patch_size", None) == 4, "PatchEmbed cần thuộc tính patch_size (bằng đối số patch_size)."
    conv = getattr(m, "proj", None)
    assert isinstance(conv, nn.Conv2d), "PatchEmbed cần thuộc tính proj là một nn.Conv2d."
    assert (conv.in_channels, conv.out_channels) == (3, 16), f"proj phải là Conv2d(in_ch = 3, embed_dim = 16), hiện là ({conv.in_channels}, {conv.out_channels})."
    assert conv.kernel_size == (4, 4), f"proj.kernel_size = {conv.kernel_size}, cần (4, 4): mỗi patch phải được đọc trọn."
    assert conv.stride == (4, 4), f"proj.stride = {conv.stride}, cần (4, 4): nếu các cửa sổ chồng lên nhau thì đó không phải là lưới patch."
    assert conv.padding == (0, 0), "proj không có padding: lưới patch phủ vừa khít ảnh."
    assert conv.bias is not None, "proj cần có bias (như một lớp Linear thường)."
    want = sorted(ref["PatchEmbed"](3, 16, 4).state_dict())
    assert sorted(m.state_dict()) == want, f"Tên tham số trong state_dict là {sorted(m.state_dict())}, cần {want}."


def test_embed_forward(user, ref):
    """PatchEmbed cho shape (B, N, embed_dim) và khớp lời giải chuẩn: ảnh vuông, chữ nhật, một kênh, một patch"""
    for i, (shape, dim, p) in enumerate([((2, 3, 8, 12), 16, 4), ((1, 1, 6, 6), 5, 3), ((3, 2, 4, 8), 7, 2), ((2, 3, 4, 4), 6, 4)]):
        m, q = _embed_pair(user, ref, shape[1], dim, p, seed=i)
        x = _img(shape, 30 + i)
        y = m(x)
        t.shape(y, (shape[0], (shape[2] // p) * (shape[3] // p), dim), what=f"PatchEmbed với x shape {shape}, p = {p}, embed_dim = {dim}")
        t.close(y, q(x), tol=1e-4, what=f"PatchEmbed với x shape {shape}, p = {p} (sau conv, lưới (H/p, W/p) phải thành chuỗi N token và embed_dim đứng cuối)")


def test_embed_token_order(user, ref):
    """Token đúng thứ tự patch: chỉ patch ở hàng 1, cột 2 của lưới 3×4 có nội dung thì chỉ token số 6 khác bias"""
    p, hp, wp, dim = 4, 3, 4, 8
    m = need(user, "PatchEmbed")(2, dim, p)
    x = torch.zeros(1, 2, hp * p, wp * p)
    x[:, :, 1 * p:2 * p, 2 * p:3 * p] = _img((1, 2, p, p), 40)
    y = m(x)
    t.shape(y, (1, hp * wp, dim), what="đầu ra của PatchEmbed với ảnh 12×16, p = 4")
    bias = m.proj.bias.detach()
    for k in range(hp * wp):
        diff = float((y[0, k].detach() - bias).abs().max())
        if k == 6:
            assert diff > 1e-3, "Token số 6 (patch hàng 1, cột 2 của lưới 3×4) không khác bias: nội dung của patch đó đã đi đâu?"
        else:
            assert diff < 1e-5, f"Token số {k} khác bias dù patch tương ứng toàn số 0: patch hàng 1, cột 2 của lưới 3×4 phải thành token số 6 (quét hàng trước cột), không rơi vào token {k}."


def test_embed_equals_linear(user, ref):
    """Nhất quán: patchify(x, p) @ proj.weight.flatten(1).T + proj.bias bằng đúng PatchEmbed(x) (conv stride p = Linear trên patch đã duỗi)"""
    f = need(user, "patchify")
    for i, (shape, dim, p) in enumerate([((2, 3, 8, 12), 10, 4), ((1, 1, 6, 4), 3, 2), ((2, 2, 6, 9), 5, 3)]):
        t.seed(50 + i)
        m = need(user, "PatchEmbed")(shape[1], dim, p)
        x = _img(shape, 60 + i)
        lin = f(x, p) @ m.proj.weight.detach().flatten(1).T + m.proj.bias.detach()
        t.close(m(x), lin, tol=1e-4, what=f"PatchEmbed(x) so với patchify(x, p) @ W.T + b, x shape {shape}, p = {p} (thứ tự duỗi trong patch của patchify có khớp với cách conv đọc kernel không?)")
