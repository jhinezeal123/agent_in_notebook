def _make(ns, name, *args, seed=0):
    t.seed(seed)
    return need(ns, name)(*args)


def test_linear_parameters(user, ref):
    """MyLinear: weight (out, in) và bias (out,) được đăng ký làm tham số"""
    m = _make(user, "MyLinear", 4, 3)
    shapes = {n: tuple(p.shape) for n, p in m.named_parameters()}
    assert shapes, "module.parameters() rỗng: tensor gán thẳng vào self thì module có 'thấy' nó là tham số không?"
    assert set(shapes) == {"weight", "bias"}, f"Tham số của MyLinear là {sorted(shapes)}, cần đúng ['bias', 'weight']."
    assert shapes["weight"] == (3, 4), f"weight có shape {shapes['weight']}, cần (out_features, in_features) = (3, 4)."
    assert shapes["bias"] == (3,), f"bias có shape {shapes['bias']}, cần (3,)."
    assert all(p.requires_grad for p in m.parameters()), "Tham số phải có requires_grad=True."


def test_linear_forward(user, ref):
    """MyLinear: forward khớp lời giải chuẩn với x 2 chiều và 3 chiều"""
    m = _make(user, "MyLinear", 4, 3, seed=1)
    r = _make(ref, "MyLinear", 4, 3, seed=2)
    t.load_into(m, r)
    g = torch.Generator().manual_seed(3)
    x = torch.randn(5, 4, generator=g)
    out = m(x)
    t.shape(out, (5, 3), what="MyLinear(4, 3) với x shape (5, 4)")
    t.close(out, r(x), what="đầu ra của MyLinear")
    x3 = torch.randn(2, 3, 4, generator=g)
    out3 = m(x3)
    t.shape(out3, (2, 3, 3), what="MyLinear(4, 3) với x shape (2, 3, 4)")
    t.close(out3, r(x3), what="đầu ra của MyLinear với x 3 chiều")


def test_linear_init(user, ref):
    """MyLinear: khởi tạo đều trong ±1/√in_features, mỗi seed một khác"""
    m = _make(user, "MyLinear", 100, 50, seed=4)
    w, b = t.array(m.weight), t.array(m.bias)
    assert w.shape == (50, 100), f"weight có shape {w.shape}, cần (50, 100)."
    assert np.abs(w).max() <= 0.1 + 1e-6, f"Có trọng số lớn tới {np.abs(w).max():.3f}, vượt 1/√in_features = 0.1."
    assert 0.045 < w.std() < 0.07, f"Độ lệch chuẩn của weight là {w.std():.4f}: chưa giống phân phối đều trên [-0.1, 0.1]."
    assert np.abs(b).max() <= 0.1 + 1e-6, f"Có bias lớn tới {np.abs(b).max():.3f}, vượt 1/√in_features = 0.1."
    other = _make(user, "MyLinear", 100, 50, seed=5)
    assert not np.allclose(w, t.array(other.weight)), "Hai seed khác nhau mà cho cùng weight: khởi tạo phải ngẫu nhiên."


def test_mlp_structure(user, ref):
    """MLP: đúng tên và shape tham số, fc1 và fc2 là MyLinear"""
    my_linear = need(user, "MyLinear")
    model = _make(user, "MLP", 4, 8, 3, seed=6)
    shapes = {n: tuple(p.shape) for n, p in model.named_parameters()}
    want = {"fc1.weight": (8, 4), "fc1.bias": (8,), "fc2.weight": (3, 8), "fc2.bias": (3,)}
    assert shapes == want, f"Tham số của MLP(4, 8, 3) là {shapes}, cần {want}."
    assert isinstance(model.fc1, my_linear) and isinstance(model.fc2, my_linear), "fc1 và fc2 phải là MyLinear của bạn."


def test_mlp_forward(user, ref):
    """MLP: forward khớp lời giải chuẩn khi cùng trọng số"""
    model = _make(user, "MLP", 4, 8, 3, seed=7)
    r = _make(ref, "MLP", 4, 8, 3, seed=8)
    t.load_into(model, r)
    x = torch.randn(6, 4, generator=torch.Generator().manual_seed(9)) * 2
    out = model(x)
    t.shape(out, (6, 3), what="MLP(4, 8, 3) với x shape (6, 4)")
    t.close(out, r(x), what="đầu ra của MLP (giữa hai lớp có gì?)")


def test_mlp_trains(user, ref):
    """MLP: optimizer thấy mọi tham số, một bước SGD làm chúng thay đổi"""
    model = _make(user, "MLP", 4, 8, 3, seed=10)
    params = list(model.parameters())
    assert len(params) == 4, f"model.parameters() có {len(params)} tensor, cần 4: optimizer chỉ cập nhật những gì nằm trong đó."
    opt = torch.optim.SGD(params, lr=0.1)
    g = torch.Generator().manual_seed(11)
    x = torch.randn(16, 4, generator=g)
    y = torch.randint(0, 3, (16,), generator=g)
    before = {n: p.detach().clone() for n, p in model.named_parameters()}
    opt.zero_grad()
    F.cross_entropy(model(x), y).backward()
    for n, p in model.named_parameters():
        assert p.grad is not None, f"{n} không nhận được gradient."
    opt.step()
    for n in ["fc2.weight", "fc2.bias"]:
        now = dict(model.named_parameters())[n].detach()
        assert not torch.equal(now, before[n]), f"{n} không đổi sau một bước SGD."
