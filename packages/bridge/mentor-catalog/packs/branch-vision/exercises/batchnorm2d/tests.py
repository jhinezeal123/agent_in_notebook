C = 3


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _x(shape, seed):
    # mỗi kênh một trung bình và một độ lệch riêng; H ≠ W để lộ nhầm trục
    c = shape[1]
    mu = (torch.arange(c, dtype=torch.float32) * 2.0 - 1.0).view(1, c, 1, 1)
    sd = (1.0 + 0.5 * torch.arange(c, dtype=torch.float32)).view(1, c, 1, 1)
    return torch.randn(shape, generator=_g(seed)) * sd + mu


def _make(user, c=C, **kw):
    return need(user, "BatchNorm2d")(c, **kw)


def _pair(user, ref, c=C, seed=0, **kw):
    """Hai module (của bạn, chuẩn) cùng γ, β và cùng running stats khởi đầu (đều khác giá trị mặc định)."""
    m = _make(user, c, **kw)
    q = ref["BatchNorm2d"](c, **kw)
    g = _g(seed)
    with torch.no_grad():
        q.weight.copy_(0.5 + torch.rand(c, generator=g))
        q.bias.copy_(torch.randn(c, generator=g) * 0.5)
        q.running_mean.copy_(torch.randn(c, generator=g))
        q.running_var.copy_(0.5 + torch.rand(c, generator=g))
    t.load_into(m, q)
    return m, q


def test_structure(user, ref):
    """Có weight (γ, toàn 1) và bias (β, toàn 0) là tham số; running_mean (0), running_var (1), num_batches_tracked (0) là buffer; eps và momentum mặc định"""
    m = _make(user)
    assert isinstance(m, nn.Module), "BatchNorm2d phải là một nn.Module."
    params = dict(m.named_parameters())
    assert sorted(params) == ["bias", "weight"], f"Tham số của module là {sorted(params)}, cần đúng ['bias', 'weight']: running stats không học bằng gradient nên không phải tham số."
    for name, want in [("weight", 1.0), ("bias", 0.0)]:
        p = params[name]
        assert tuple(p.shape) == (C,), f"{name} có shape {tuple(p.shape)}, cần ({C},): một số cho mỗi kênh."
        assert bool((p.detach() == want).all()), f"{name} phải khởi tạo toàn số {want} (lúc đầu chỉ chuẩn hóa, chưa co giãn hay dịch)."
    bufs = dict(m.named_buffers())
    assert sorted(bufs) == ["num_batches_tracked", "running_mean", "running_var"], f"Buffer của module là {sorted(bufs)}, cần running_mean, running_var, num_batches_tracked (tạo bằng register_buffer để chúng nằm trong state_dict mà không thành tham số)."
    for name, want in [("running_mean", 0.0), ("running_var", 1.0)]:
        b = bufs[name]
        assert tuple(b.shape) == (C,) and bool((b == want).all()), f"{name} phải có shape ({C},) và khởi tạo toàn số {want}."
    nb = bufs["num_batches_tracked"]
    assert nb.dtype == torch.long and nb.dim() == 0 and int(nb) == 0, "num_batches_tracked phải là tensor số nguyên (torch.long) 0 chiều, khởi tạo bằng 0."
    assert getattr(m, "eps", None) == 1e-5, "eps mặc định phải là 1e-5 và lưu ở thuộc tính eps."
    assert getattr(m, "momentum", None) == 0.1, "momentum mặc định phải là 0.1 và lưu ở thuộc tính momentum."
    m2 = _make(user, 5, eps=1e-3, momentum=0.3)
    assert m2.eps == 1e-3 and m2.momentum == 0.3, "eps và momentum phải lấy từ đối số truyền vào."
    assert m.training, "Module mới tạo phải ở chế độ train (self.training là True)."
    assert not list(m.children()), "BatchNorm2d của bạn chứa module con (có dùng nn.BatchNorm bên trong không?): tự viết, đừng bọc."


def test_train_forward(user, ref):
    """Train: chuẩn hóa từng kênh theo (N, H, W) bằng thống kê của chính batch đó; khớp lời giải chuẩn với N = 1, H ≠ W và H = W = 1"""
    for i, shape in enumerate([(4, 3, 5, 6), (1, 3, 4, 4), (5, 3, 1, 1)]):
        m, q = _pair(user, ref, seed=i)
        x = _x(shape, 10 + i)
        got = m(x)
        t.shape(got, shape, what=f"đầu ra với x shape {shape}")
        t.close(got, q(x), tol=1e-4, what=f"đầu ra ở chế độ train với x shape {shape} (trung bình và phương sai theo từng kênh, gộp N, H và W)")
    m = _make(user)
    y = m(_x((6, 3, 4, 5), 20))
    t.close(y.mean(dim=(0, 2, 3)), torch.zeros(3), tol=1e-4, what="trung bình của đầu ra theo từng kênh (γ = 1, β = 0)")
    var = ((y - y.mean(dim=(0, 2, 3), keepdim=True)) ** 2).mean(dim=(0, 2, 3))
    t.close(var, torch.ones(3), tol=1e-3, what="phương sai của đầu ra theo từng kênh (γ = 1, β = 0)")


def test_running_mean(user, ref):
    """running_mean ← (1 − momentum)·cũ + momentum·trung bình batch, qua nhiều bước, với momentum 0.1 và 0.4; num_batches_tracked đếm số lần train"""
    for momentum in [0.1, 0.4]:
        m, q = _pair(user, ref, momentum=momentum, seed=3)
        for i in range(3):
            x = _x((4, 3, 5, 6), 30 + i)
            before = t.array(m.running_mean)
            m(x)
            q(x)
            want = (1 - momentum) * before + momentum * t.array(x).mean(axis=(0, 2, 3))
            t.close(m.running_mean, want, tol=1e-4, what=f"running_mean sau bước {i + 1} với momentum = {momentum} (momentum là phần của batch mới đi vào)")
        assert int(m.num_batches_tracked) == 3, f"num_batches_tracked = {int(m.num_batches_tracked)} sau 3 lần forward ở chế độ train, cần 3."


def test_running_var(user, ref):
    """running_var ← (1 − momentum)·cũ + momentum·phương sai KHÔNG thiên lệch của batch (chia n − 1, n = N·H·W); thử cả batch rất nhỏ"""
    for shape in [(2, 3, 2, 2), (3, 3, 4, 5)]:
        m, q = _pair(user, ref, momentum=0.2, seed=4)
        n = shape[0] * shape[2] * shape[3]
        for i in range(2):
            x = _x(shape, 40 + i)
            before = t.array(m.running_var)
            m(x)
            q(x)
            want = 0.8 * before + 0.2 * t.array(x).var(axis=(0, 2, 3), ddof=1)
            t.close(m.running_var, want, tol=1e-4, what=f"running_var sau bước {i + 1} với x shape {shape} (n = {n} giá trị mỗi kênh: phương sai đi vào running stats chia cho bao nhiêu?)")


def test_eval_mode(user, ref):
    """Eval: dùng running_mean và running_var (không dùng thống kê của batch), không đổi buffer nào, mỗi mẫu không phụ thuộc các mẫu khác"""
    m, q = _pair(user, ref, seed=5)
    for i in range(3):
        x = _x((4, 3, 5, 6), 50 + i)
        m(x)
        q(x)
    m.eval()
    q.eval()
    names = ["running_mean", "running_var", "num_batches_tracked"]
    snap = [t.array(getattr(m, n)).copy() for n in names]
    x = _x((4, 3, 5, 6), 60) * 1.7 + 0.8
    got = m(x)
    t.close(got, q(x), tol=1e-4, what="đầu ra ở chế độ eval (sau vài bước train)")
    for n, was in zip(names, snap):
        t.close(getattr(m, n), was, tol=0, what=f"{n} sau một lần eval (eval không được cập nhật nó)")
    t.close(m(x[:1]), got[:1], tol=1e-5, what="đầu ra của mẫu đầu khi đưa riêng nó vào (ở eval kết quả không phụ thuộc các mẫu khác trong batch)")
    with torch.no_grad():
        m.running_mean.copy_(torch.tensor([0.5, -1.0, 2.0]))
        m.running_var.copy_(torch.tensor([0.25, 4.0, 1.0]))
    mu = m.running_mean.view(1, 3, 1, 1)
    var = m.running_var.view(1, 3, 1, 1)
    want = (x - mu) / torch.sqrt(var + 1e-5) * m.weight.detach().view(1, 3, 1, 1) + m.bias.detach().view(1, 3, 1, 1)
    t.close(m(x), want, tol=1e-4, what="đầu ra eval khi running stats được đặt tay")


def test_mode_switch(user, ref):
    """train() / eval() đổi hành vi đúng lúc: chỉ lần forward ở chế độ train mới tăng num_batches_tracked và cập nhật running stats"""
    m, q = _pair(user, ref, seed=6)
    x = _x((4, 3, 5, 6), 70)
    y = _x((4, 3, 5, 6), 71) * 2.0 + 1.0
    m(x)
    q(x)
    assert int(m.num_batches_tracked) == 1, "Sau một forward ở chế độ train, num_batches_tracked phải bằng 1."
    m.eval()
    q.eval()
    assert not m.training, "m.eval() phải đưa module sang chế độ eval (self.training là False)."
    before = [t.array(m.running_mean).copy(), t.array(m.running_var).copy()]
    m(y)
    m(y)
    assert int(m.num_batches_tracked) == 1, "Forward ở chế độ eval làm đổi num_batches_tracked: chỉ chế độ train mới đếm."
    t.close(m.running_mean, before[0], tol=0, what="running_mean sau hai lần eval (không được đổi)")
    t.close(m.running_var, before[1], tol=0, what="running_var sau hai lần eval (không được đổi)")
    m.train()
    q.train()
    assert m.training, "m.train() phải đưa module trở lại chế độ train."
    m(y)
    q(y)
    assert int(m.num_batches_tracked) == 2, "Sau khi quay lại chế độ train và forward một lần, num_batches_tracked phải bằng 2."
    t.close(m.running_mean, q.running_mean, tol=1e-4, what="running_mean sau chuỗi train, eval, train")
    t.close(m.running_var, q.running_var, tol=1e-4, what="running_var sau chuỗi train, eval, train")


def test_eps(user, ref):
    """ε cộng vào phương sai TRƯỚC khi lấy căn và lấy đúng giá trị truyền vào: thử eps = 0.5 ở cả train và eval"""
    m, q = _pair(user, ref, eps=0.5, seed=7)
    x = _x((4, 3, 5, 6), 80)
    t.close(m(x), q(x), tol=1e-4, what="đầu ra train với eps = 0.5 (ε nằm ở đâu trong mẫu số?)")
    m.eval()
    q.eval()
    t.close(m(x), q(x), tol=1e-4, what="đầu ra eval với eps = 0.5 (ε nằm ở đâu trong mẫu số?)")


def test_gradients(user, ref):
    """Gradient (train): theo x, weight và bias khớp lời giải chuẩn (thống kê của batch nằm trong đồ thị tính toán); running stats không nhận gradient"""
    m, q = _pair(user, ref, seed=8)
    x = _x((3, 3, 4, 5), 90)
    w = torch.randn(x.shape, generator=_g(91))
    xm = x.clone().requires_grad_(True)
    xq = x.clone().requires_grad_(True)
    (m(xm) * w).sum().backward()
    (q(xq) * w).sum().backward()
    t.close(xm.grad, xq.grad, tol=1e-4, what="gradient theo x (mean và var của batch phụ thuộc x: gradient có đi qua chúng không?)")
    t.close(m.weight.grad, q.weight.grad, tol=1e-4, what="gradient của weight")
    t.close(m.bias.grad, q.bias.grad, tol=1e-4, what="gradient của bias")
    for name in ["running_mean", "running_var"]:
        b = getattr(m, name)
        assert not b.requires_grad and b.grad_fn is None, f"{name} đang dính vào đồ thị tính gradient: cập nhật running stats phải nằm ngoài autograd, và buffer không được thành tensor có lịch sử."


def test_single_value_per_channel(user, ref):
    """Train mà mỗi kênh chỉ có 1 giá trị (N·H·W = 1) thì raise ValueError; N = 1 nhưng H·W > 1 hợp lệ; eval thì vẫn chạy với 1 giá trị"""
    m, _ = _pair(user, ref, seed=9)
    one = _x((1, 3, 1, 1), 100)
    try:
        m(one)
    except ValueError:
        pass
    else:
        raise AssertionError("Train với N·H·W = 1 (mỗi kênh một giá trị) không raise ValueError: phương sai không thiên lệch chia cho 0 ở đâu?")
    out = m(_x((1, 3, 2, 2), 101))
    assert bool(torch.isfinite(out).all()), "N = 1 nhưng H·W = 4 là hợp lệ (mỗi kênh có 4 giá trị) mà đầu ra có nan hoặc inf."
    m.eval()
    out = m(one)
    t.shape(out, (1, 3, 1, 1), what="đầu ra eval với x shape (1, 3, 1, 1)")
    assert bool(torch.isfinite(out).all()), "Eval với một giá trị mỗi kênh phải chạy được (nó dùng running stats, không dùng batch)."


def test_no_builtin(user, ref):
    """Tự cài: không kế thừa hay bọc nn.BatchNorm, không gọi F.batch_norm hay torch.batch_norm"""
    cls = need(user, "BatchNorm2d")
    assert not issubclass(cls, nn.modules.batchnorm._BatchNorm), "BatchNorm2d của bạn kế thừa lớp BatchNorm có sẵn của PyTorch: bài này là tự viết nó."
    m = cls(C)
    assert not list(m.children()), "BatchNorm2d của bạn chứa module con (nn.BatchNorm bên trong?): tự viết, đừng bọc."

    def boom(*a, **k):
        raise AssertionError("Code của bạn gọi hàm batch_norm có sẵn của PyTorch (F.batch_norm / torch.batch_norm): bài này là tự viết phép đó.")

    saved = (F.batch_norm, torch.batch_norm)
    F.batch_norm, torch.batch_norm = boom, boom
    try:
        x = _x((4, 3, 5, 6), 110)
        m(x)
        m.eval()
        m(x)
    finally:
        F.batch_norm, torch.batch_norm = saved
