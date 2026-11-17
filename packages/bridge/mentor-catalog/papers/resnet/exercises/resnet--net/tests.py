def _g(seed):
    return torch.Generator().manual_seed(seed)


def _x(shape, seed):
    return torch.randn(shape, generator=_g(seed))


def _net(user, n, shortcut=True, num_classes=10, seed=0):
    t.seed(seed)
    return need(user, "ResNetCifar")(n, shortcut=shortcut, num_classes=num_classes)


def _weighted_layers(m):
    """Số lớp có trọng số theo cách đếm của paper: conv 3x3 và Linear (conv 1x1 của đường tắt projection không tính)."""
    return sum(1 for mod in m.modules() if (isinstance(mod, nn.Conv2d) and mod.kernel_size == (3, 3)) or isinstance(mod, nn.Linear))


def _n_params(m):
    return sum(p.numel() for p in m.parameters())


def _pair(user, ref, n, shortcut, seed=0):
    """Hai mạng (của bạn, chuẩn) cùng trọng số; mọi Batch Norm của bản chuẩn có γ, β và running stats khác mặc định."""
    m = _net(user, n, shortcut, seed=seed)
    t.seed(seed + 1)
    q = ref["ResNetCifar"](n, shortcut=shortcut)
    with torch.no_grad():
        bns = [mod for mod in q.modules() if isinstance(mod, nn.BatchNorm2d)]
        for k, mod in enumerate(bns):
            mod.weight.copy_(0.5 + torch.rand(mod.weight.shape, generator=_g(seed + 100 * k + 2)))
            mod.bias.copy_(torch.randn(mod.bias.shape, generator=_g(seed + 100 * k + 3)) * 0.3)
            mod.running_mean.copy_(torch.randn(mod.bias.shape, generator=_g(seed + 100 * k + 4)) * 0.5)
            mod.running_var.copy_(0.5 + torch.rand(mod.bias.shape, generator=_g(seed + 100 * k + 5)))
    t.load_into(m, q)
    return m, q


def test_depth_6n_plus_2(user, ref):
    """Số lớp có trọng số (conv 3×3 và Linear) đúng 6n + 2, ở cả mạng có và không có shortcut, với n = 1, 3, 5"""
    for n in (1, 3, 5):
        for shortcut in (True, False):
            got = _weighted_layers(_net(user, n, shortcut))
            assert got == 6 * n + 2, f"ResNetCifar(n={n}, shortcut={shortcut}) có {got} lớp có trọng số, cần 6n + 2 = {6 * n + 2}: mỗi stage có bao nhiêu khối, mỗi khối mấy conv 3×3?"


def test_stages(user, ref):
    """Lớp đầu ra 16 kênh; mỗi stage có đúng n khối; sau ba stage ảnh 32×32 thành (16, 32, 32), (32, 16, 16), (64, 8, 8)"""
    for n in (2, 3):
        net = _net(user, n)
        stem = getattr(net, "conv1", None)
        assert isinstance(stem, nn.Conv2d), "Mạng cần thuộc tính conv1 là nn.Conv2d (lớp conv đầu tiên)."
        assert stem.in_channels == 3 and stem.out_channels == 16 and stem.kernel_size == (3, 3) and stem.stride == (1, 1), f"conv1 phải là conv 3×3 từ 3 kênh ra 16 kênh, stride 1 (hiện là {stem.in_channels} -> {stem.out_channels} kênh, stride {stem.stride})."
        shapes = {}
        hooks = []
        for name in ("layer1", "layer2", "layer3"):
            stage = getattr(net, name, None)
            assert isinstance(stage, nn.Sequential), f"Mạng cần thuộc tính {name} là nn.Sequential gồm các khối của stage."
            assert len(stage) == n, f"{name} có {len(stage)} khối, cần n = {n} (n khối mỗi stage, mỗi khối hai conv: ba stage cho 6n conv)."
            hooks.append(stage.register_forward_hook(lambda mod, inp, out, name=name: shapes.__setitem__(name, tuple(out.shape))))
        net.eval()
        try:
            with torch.no_grad():
                net(_x((2, 3, 32, 32), 5))
        finally:
            for h in hooks:
                h.remove()
        for name, want in [("layer1", (2, 16, 32, 32)), ("layer2", (2, 32, 16, 16)), ("layer3", (2, 64, 8, 8))]:
            assert shapes.get(name) == want, f"Đầu ra của {name} có shape {shapes.get(name)}, cần {want} với ảnh (2, 3, 32, 32): stage nào giảm độ phân giải, và ở khối nào của stage?"


def test_output_shape(user, ref):
    """Logits có shape (B, num_classes) cho ảnh 32×32, với num_classes khác 10, và cả với ảnh 16×16 (pooling toàn cục, không cố định kích thước)"""
    net = _net(user, 2)
    net.eval()
    with torch.no_grad():
        t.shape(net(_x((3, 3, 32, 32), 1)), (3, 10), what="logits với ảnh (3, 3, 32, 32)")
        t.shape(net(_x((2, 3, 16, 16), 2)), (2, 10), what="logits với ảnh (2, 3, 16, 16)")
        t.shape(net(_x((1, 3, 32, 32), 3)), (1, 10), what="logits với một ảnh (1, 3, 32, 32)")
    net7 = _net(user, 1, num_classes=7)
    net7.eval()
    with torch.no_grad():
        t.shape(net7(_x((2, 3, 32, 32), 4)), (2, 7), what="logits khi num_classes = 7")


def test_param_count(user, ref):
    """Số tham số của ResNetCifar(3) khớp bản chuẩn (ResNet-20 cỡ 0,27 triệu), có và không có shortcut: không lớp thừa, không kênh sai"""
    for shortcut in (True, False):
        got = _n_params(_net(user, 3, shortcut))
        t.seed(0)
        want = _n_params(ref["ResNetCifar"](3, shortcut=shortcut))
        assert got == want, f"ResNetCifar(3, shortcut={shortcut}) có {got:,} tham số, bản chuẩn có {want:,}: kiểm tra số kênh mỗi stage, các conv và BN thừa hay thiếu, và chỗ nào cần projection."


def test_matches_reference_residual(user, ref):
    """ResNetCifar(2, shortcut=True) cho cùng logits với bản chuẩn khi cùng trọng số, ở chế độ train rồi chế độ eval"""
    m, q = _pair(user, ref, 2, True)
    x = _x((4, 3, 32, 32), 9)
    m.train()
    q.train()
    with torch.no_grad():
        t.close(m(x), q(x), tol=1e-4, what="logits ở chế độ train (BN dùng thống kê của batch)")
    m.eval()
    q.eval()
    with torch.no_grad():
        t.close(m(x), q(x), tol=1e-4, what="logits ở chế độ eval")


def test_matches_reference_plain(user, ref):
    """ResNetCifar(2, shortcut=False) (mạng plain) cho cùng logits với bản chuẩn khi cùng trọng số; tên tham số không có shortcut nào"""
    m, q = _pair(user, ref, 2, False)
    x = _x((4, 3, 32, 32), 10)
    m.train()
    q.train()
    with torch.no_grad():
        t.close(m(x), q(x), tol=1e-4, what="logits của mạng plain ở chế độ train")
    m.eval()
    q.eval()
    with torch.no_grad():
        t.close(m(x), q(x), tol=1e-4, what="logits của mạng plain ở chế độ eval")


def test_reuses_blocks(user, ref):
    """shortcut=True dựng mạng bằng ResidualBlock của bạn; shortcut=False dựng bằng PlainBlock (cho sẵn), không lẫn hai loại"""
    RB, PB = need(user, "ResidualBlock"), need(user, "PlainBlock")
    for shortcut, want, other in [(True, RB, PB), (False, PB, RB)]:
        net = _net(user, 2, shortcut)
        blocks = [*net.layer1, *net.layer2, *net.layer3]
        assert all(isinstance(b, want) for b in blocks), f"Với shortcut={shortcut}, mọi khối phải là {want.__name__}: bạn đã dùng lại khối có sẵn chưa, và công tắc đã chọn đúng loại khối?"
        assert not any(isinstance(b, other) for b in blocks), f"Với shortcut={shortcut}, không được có khối {other.__name__} nào trong mạng."


def test_plain_has_no_skip(user, ref):
    """Làm mọi conv 3×3 trong các khối bằng 0: mạng plain cho cùng một đầu ra với mọi ảnh (không còn đường nào đi vòng), mạng residual vẫn phụ thuộc ảnh"""
    for shortcut in (False, True):
        net = _net(user, 2, shortcut)
        stem = getattr(net, "conv1", None)
        with torch.no_grad():
            for mod in net.modules():
                if isinstance(mod, nn.Conv2d) and mod.kernel_size == (3, 3) and mod is not stem:
                    mod.weight.zero_()
        net.eval()
        with torch.no_grad():
            a, b = net(_x((2, 3, 32, 32), 11)), net(_x((2, 3, 32, 32), 12))
        spread = float((a - b).abs().max())
        if shortcut:
            assert spread > 1e-4, "Mạng residual mà các conv trong khối bằng 0 vẫn phải cho đầu ra phụ thuộc ảnh (đường tắt mang tín hiệu đi): đường tắt của bạn có thực sự cộng x vào không?"
        else:
            assert spread < 1e-5, f"Mạng plain mà các conv trong khối bằng 0 vẫn còn phụ thuộc ảnh (lệch {spread:.2e}): còn một đường đi vòng qua các khối, mà plain không được có đường tắt."
