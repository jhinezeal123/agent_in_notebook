# (in_ch, out_ch, stride): đồng nhất; đổi kênh và giảm độ phân giải; giảm độ phân giải mà giữ kênh; đổi kênh mà giữ độ phân giải
CONFIGS = [(8, 8, 1), (8, 16, 2), (8, 8, 2), (8, 16, 1)]


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _x(shape, seed):
    return torch.randn(shape, generator=_g(seed))


def _pair(user, ref, cin, cout, stride, seed=0):
    """Hai khối (của bạn, chuẩn) cùng trọng số; mọi Batch Norm của bản chuẩn có γ, β và running stats khác mặc định."""
    t.seed(seed)
    m = need(user, "ResidualBlock")(cin, cout, stride)
    t.seed(seed + 1)
    q = ref["ResidualBlock"](cin, cout, stride)
    with torch.no_grad():
        bns = [mod for mod in q.modules() if isinstance(mod, nn.BatchNorm2d)]
        for k, mod in enumerate(bns):  # mỗi Batch Norm một bộ giá trị riêng
            mod.weight.copy_(0.5 + torch.rand(mod.weight.shape, generator=_g(seed + 100 * k + 2)))
            mod.bias.copy_(torch.randn(mod.bias.shape, generator=_g(seed + 100 * k + 3)) * 0.3)
            mod.running_mean.copy_(torch.randn(mod.bias.shape, generator=_g(seed + 100 * k + 4)) * 0.5)
            mod.running_var.copy_(0.5 + torch.rand(mod.bias.shape, generator=_g(seed + 100 * k + 5)))
    t.load_into(m, q)
    return m, q


def _attr(m, name, kind):
    v = getattr(m, name, None)
    assert isinstance(v, kind), f"Khối cần thuộc tính {name} là {kind.__name__} (hiện là {type(v).__name__})."
    return v


def _silence_main(m, bias=0.0):
    """Làm nhánh chính F(x) cho ra đúng hằng số `bias` ở mọi nơi (γ của bn2 = 0, β của bn2 = bias); shortcut không bị đụng tới."""
    with torch.no_grad():
        m.bn2.weight.zero_()
        m.bn2.bias.fill_(bias)


def test_structure(user, ref):
    """Đúng các thuộc tính conv1 (3×3, stride), bn1, conv2, bn2 và shortcut (Identity hay projection 1×1 + BN) ở cả bốn cấu hình, tên tham số khớp đề"""
    for cin, cout, s in CONFIGS:
        tag = f"ResidualBlock({cin}, {cout}, stride={s})"
        m = need(user, "ResidualBlock")(cin, cout, s)
        c1, c2 = _attr(m, "conv1", nn.Conv2d), _attr(m, "conv2", nn.Conv2d)
        assert (c1.in_channels, c1.out_channels) == (cin, cout) and c1.kernel_size == (3, 3) and c1.padding == (1, 1), f"{tag}: conv1 phải là Conv2d({cin}, {cout}) với kernel 3×3, padding 1."
        assert c1.stride == (s, s), f"{tag}: conv1.stride = {c1.stride}, cần ({s}, {s}): chỗ nào của khối thì giảm độ phân giải?"
        assert (c2.in_channels, c2.out_channels) == (cout, cout) and c2.kernel_size == (3, 3) and c2.padding == (1, 1) and c2.stride == (1, 1), f"{tag}: conv2 phải là Conv2d({cout}, {cout}) với kernel 3×3, padding 1, stride 1."
        assert c1.bias is None and c2.bias is None, f"{tag}: conv đứng trước Batch Norm không cần bias (bias=False)."
        for name in ["bn1", "bn2"]:
            bn = _attr(m, name, nn.BatchNorm2d)
            assert bn.num_features == cout, f"{tag}: {name} phải là BatchNorm2d({cout})."
        sc = getattr(m, "shortcut", None)
        assert isinstance(sc, nn.Module), f"{tag}: thiếu thuộc tính shortcut."
        if s == 1 and cin == cout:
            assert not list(sc.parameters()), f"{tag}: shape của x đã khớp với F(x) nên shortcut là phép đồng nhất (không có tham số), nhưng shortcut của bạn có tham số."
        else:
            assert isinstance(sc, nn.Sequential) and len(sc) == 2 and isinstance(sc[0], nn.Conv2d) and isinstance(sc[1], nn.BatchNorm2d), f"{tag}: shortcut phải là nn.Sequential gồm Conv2d 1×1 rồi BatchNorm2d (hiện là {type(sc).__name__})."
            conv = sc[0]
            assert (conv.in_channels, conv.out_channels) == (cin, cout) and conv.kernel_size == (1, 1) and conv.stride == (s, s) and conv.padding == (0, 0) and conv.bias is None, f"{tag}: Conv của shortcut phải là Conv2d({cin}, {cout}, kernel 1×1, stride {s}, không padding, không bias)."
            assert sc[1].num_features == cout, f"{tag}: BatchNorm2d của shortcut phải có {cout} kênh."
        want = sorted(ref["ResidualBlock"](cin, cout, s).state_dict())
        assert sorted(m.state_dict()) == want, f"{tag}: tên tham số trong state_dict là {sorted(m.state_dict())}, cần {want}."


def test_shapes(user, ref):
    """Shape đầu ra (B, out_ch, ⌈H/stride⌉, ⌈W/stride⌉) ở cả bốn cấu hình, kể cả ảnh lẻ (7×7) và H ≠ W"""
    cases = [((2, 8, 8, 8), cfg) for cfg in CONFIGS] + [((2, 8, 7, 7), (8, 16, 2)), ((2, 8, 6, 10), (8, 8, 2)), ((1, 8, 5, 9), (8, 16, 2)), ((1, 8, 5, 9), (8, 8, 1))]
    for i, (shape, (cin, cout, s)) in enumerate(cases):
        m, _ = _pair(user, ref, cin, cout, s, seed=i)
        y = m(_x(shape, 10 + i))
        h, w = -(-shape[2] // s), -(-shape[3] // s)
        t.shape(y, (shape[0], cout, h, w), what=f"đầu ra của ResidualBlock({cin}, {cout}, stride={s}) với x shape {shape}")


def test_forward_values(user, ref):
    """Đầu ra (chế độ train) khớp lời giải chuẩn ở cả bốn cấu hình và với ảnh lẻ: đúng thứ tự conv, BN, ReLU và stride ở conv đầu"""
    cases = [((3, 8, 8, 8), cfg) for cfg in CONFIGS] + [((2, 8, 7, 7), (8, 16, 2))]
    for i, (shape, (cin, cout, s)) in enumerate(cases):
        m, q = _pair(user, ref, cin, cout, s, seed=20 + i)
        x = _x(shape, 30 + i)
        t.close(m(x), q(x), tol=1e-4, what=f"đầu ra của ResidualBlock({cin}, {cout}, stride={s}) với x shape {shape}")


def test_eval_mode(user, ref):
    """Chế độ eval: khớp lời giải chuẩn sau một bước train (mọi Batch Norm, cả trong shortcut, đều chuyển chế độ)"""
    for i, (cin, cout, s) in enumerate([(8, 8, 1), (8, 16, 2)]):
        m, q = _pair(user, ref, cin, cout, s, seed=40 + i)
        x = _x((3, 8, 8, 8), 50 + i)
        m(x)
        q(x)
        m.eval()
        q.eval()
        y = _x((2, 8, 8, 8), 60 + i) * 1.5 + 0.3
        t.close(m(y), q(y), tol=1e-4, what=f"đầu ra eval của ResidualBlock({cin}, {cout}, stride={s})")


def test_identity_shortcut(user, ref):
    """Shortcut đồng nhất: khi nhánh chính cho ra 0, đầu ra là ReLU(x) và gradient theo x đi thẳng qua đường tắt (bằng 1 ở nơi x > 0, 0 ở nơi còn lại)"""
    m, _ = _pair(user, ref, 8, 8, 1, seed=70)
    _silence_main(m)
    x = _x((2, 8, 6, 6), 71).requires_grad_(True)
    y = m(x)
    t.close(y, torch.relu(x.detach()), tol=1e-5, what="đầu ra khi nhánh chính cho ra 0 (phải là ReLU(x): đường tắt cộng x vào, rồi ReLU)")
    y.sum().backward()
    t.close(x.grad, (x.detach() > 0).float(), tol=1e-5, what="gradient theo x khi nhánh chính cho ra 0 (chỉ còn đường tắt: gradient 1 ở nơi x > 0)")


def test_projection_shortcut(user, ref):
    """Shortcut có projection khi đổi kênh hoặc giảm độ phân giải: khi nhánh chính cho ra 0, đầu ra là ReLU(BN(conv 1×1 stride s (x)))"""
    for i, (cin, cout, s) in enumerate([(8, 16, 2), (8, 8, 2), (8, 16, 1)]):
        m, _ = _pair(user, ref, cin, cout, s, seed=80 + i)
        _silence_main(m)
        x = _x((3, cin, 8, 8), 90 + i)
        y = m(x)
        conv, bn = m.shortcut[0], m.shortcut[1]
        z = F.conv2d(x, conv.weight.detach(), stride=s)
        z = F.batch_norm(z, None, None, bn.weight.detach(), bn.bias.detach(), training=True, eps=bn.eps)
        t.close(y, torch.relu(z), tol=1e-4, what=f"đầu ra của ResidualBlock({cin}, {cout}, stride={s}) khi nhánh chính cho ra 0 (phải bằng ReLU của projection)")


def test_relu_after_add(user, ref):
    """ReLU đứng SAU phép cộng: đầu ra không âm; với nhánh chính ≡ −1 và đường tắt đồng nhất thì đầu ra là ReLU(x − 1)"""
    for i, (cin, cout, s) in enumerate(CONFIGS):
        m, _ = _pair(user, ref, cin, cout, s, seed=100 + i)
        y = m(_x((3, cin, 8, 8), 110 + i))
        assert float(y.min()) >= 0.0, f"ResidualBlock({cin}, {cout}, stride={s}) cho ra giá trị âm (nhỏ nhất {float(y.min()):.3f}): đầu ra của khối phải đi qua ReLU sau khi cộng."
    m, _ = _pair(user, ref, 8, 8, 1, seed=120)
    _silence_main(m, bias=-1.0)
    x = _x((2, 8, 6, 6), 121)
    t.close(m(x), torch.relu(x - 1.0), tol=1e-5, what="đầu ra khi nhánh chính luôn bằng −1 (ReLU(x − 1): ReLU phải nhìn thấy tổng, không phải từng nhánh riêng)")


def test_gradients(user, ref):
    """Gradient theo x và theo trọng số của conv1, conv2 khớp lời giải chuẩn ở cấu hình đồng nhất và cấu hình có projection"""
    for i, (cin, cout, s) in enumerate([(8, 8, 1), (8, 16, 2)]):
        m, q = _pair(user, ref, cin, cout, s, seed=130 + i)
        x = _x((3, cin, 6, 6), 140 + i)
        w = torch.randn((3, cout, -(-6 // s), -(-6 // s)), generator=_g(150 + i))
        xm = x.clone().requires_grad_(True)
        xq = x.clone().requires_grad_(True)
        (m(xm) * w).sum().backward()
        (q(xq) * w).sum().backward()
        t.close(xm.grad, xq.grad, tol=1e-4, what=f"gradient theo x của ResidualBlock({cin}, {cout}, stride={s})")
        t.close(m.conv1.weight.grad, q.conv1.weight.grad, tol=1e-4, what="gradient của conv1.weight")
        t.close(m.conv2.weight.grad, q.conv2.weight.grad, tol=1e-4, what="gradient của conv2.weight")
        dead = [n for n, p in m.named_parameters() if p.grad is None]
        assert not dead, f"Các tham số này không nhận gradient (không nằm trên đường từ x tới đầu ra): {dead[:4]}."
