def _g(seed):
    return torch.Generator().manual_seed(seed)


def _check_t(x, ts):
    assert torch.is_tensor(ts) and ts.is_floating_point() and ts.shape == (x.shape[0],), f"Mô hình nhận t có kiểu/shape {getattr(ts, 'dtype', type(ts))}/{tuple(getattr(ts, 'shape', ()))}, cần tensor số thực shape (B,) = ({x.shape[0]},): đưa cho model chính t, không phải bản đã đổi shape."


class _Net(nn.Module):
    """Mô hình giả có tham số: một Linear trên (x làm phẳng, t), nhận x_t shape (B, ...) bất kỳ."""

    def __init__(self, shape):
        super().__init__()
        n = int(np.prod(shape))
        self.lin = nn.Linear(n + 1, n)

    def forward(self, x, ts):
        _check_t(x, ts)
        return self.lin(torch.cat([x.flatten(1), ts.view(-1, 1)], dim=1)).view_as(x)


class _Rec(nn.Module):
    """Mô hình giả luôn đoán 0 và ghi lại mọi (x_t, t) nó được gọi với."""

    def __init__(self):
        super().__init__()
        self.xs, self.ts = [], []

    def forward(self, x, ts):
        assert torch.is_tensor(ts), "Mô hình nhận t không phải tensor: cần tensor số thực shape (B,)."
        self.xs.append(x.detach().clone())
        self.ts.append(ts.detach().clone())
        return torch.zeros_like(x)


class _Known(nn.Module):
    """Mô hình giả biết cả x0 lẫn x1: luôn trả về đúng vận tốc x1 − x0 của đường thẳng."""

    def __init__(self, x0, x1):
        super().__init__()
        self.u = x1 - x0

    def forward(self, x, ts):
        _check_t(x, ts)
        return self.u.clone()


def test_loss_value(user, ref):
    """Với t và x0 cho sẵn: một số (shape ()) bằng trung bình, trên mọi phần tử, của (v − (x1 − x0))², chạy cho cả x1 shape (B, D) lẫn (B, C, H, W)"""
    f = need(user, "fm_loss")
    for k, shape in enumerate([(5, 4), (3, 2, 3, 3)]):
        x1 = torch.randn(*shape, generator=_g(1 + k))
        x0 = torch.randn(*shape, generator=_g(11 + k))
        ts = torch.rand(shape[0], generator=_g(21 + k))
        t.seed(30 + k)
        m = _Net(shape[1:])
        got = f(m, x1, t=ts, x0=x0)
        t.shape(got, (), what=f"fm_loss với x1 shape {shape} (một số, không phải tensor nhiều phần tử)")
        tb = ts.view(-1, *([1] * (len(shape) - 1)))
        xt = (1 - tb) * x0 + tb * x1
        with torch.no_grad():
            want = ((m(xt, ts) - (x1 - x0)) ** 2).mean()
        t.close(got, want, tol=1e-5, what=f"fm_loss với x1 shape {shape}, t và x0 cho sẵn (trung bình trên MỌI phần tử)")


def test_target_is_velocity(user, ref):
    """Mô hình giả biết đúng vận tốc x1 − x0 thì loss ≈ 0: đích là hiệu x1 − x0 (không phải x1, không đổi dấu)"""
    f = need(user, "fm_loss")
    for k, shape in enumerate([(5, 4), (3, 2, 3, 3)]):
        x1 = torch.randn(*shape, generator=_g(2 + k))
        x0 = torch.randn(*shape, generator=_g(12 + k))
        ts = torch.rand(shape[0], generator=_g(22 + k))
        got = float(f(_Known(x0, x1), x1, t=ts, x0=x0))
        assert got < 1e-8, f"Mô hình hoàn hảo (luôn đoán đúng vận tốc x1 − x0) vẫn cho loss {got:.4f} với x1 shape {shape}, đáng lẽ bằng 0. Vận tốc của đường đi từ x0 (t = 0) đến x1 (t = 1) là gì, và đích hồi quy của bạn có đúng dấu không?"


def test_interpolation_direction(user, ref):
    """x_t = (1 − t)·x0 + t·x1: t = 0 cho nhiễu x0, t = 1 cho dữ liệu x1, và mỗi mẫu dùng t của riêng nó"""
    f = need(user, "fm_loss")
    x1 = torch.randn(4, 3, generator=_g(3))
    x0 = torch.randn(4, 3, generator=_g(13))
    for tv in ([0.0] * 4, [1.0] * 4, [0.25] * 4, [0.0, 0.25, 0.5, 1.0]):
        ts = torch.tensor(tv)
        m = _Rec()
        f(m, x1, t=ts, x0=x0)
        want = torch.empty_like(x1)
        for i in range(4):
            want[i] = (1 - tv[i]) * x0[i] + tv[i] * x1[i]
        t.close(m.xs[0], want, tol=1e-6, what=f"x_t đưa cho model khi t = {tv} (t = 0 phải là nhiễu x0, t = 1 phải là dữ liệu x1, mỗi mẫu một t)")


def test_t_passed_to_model(user, ref):
    """Model nhận đúng t cho sẵn: tensor float32 shape (B,), không phải bản đã đổi shape để nội suy; được gọi đúng một lần"""
    f = need(user, "fm_loss")
    x1 = torch.randn(4, 2, 3, 3, generator=_g(4))
    x0 = torch.randn(4, 2, 3, 3, generator=_g(14))
    ts = torch.tensor([0.1, 0.4, 0.7, 0.9])
    m = _Rec()
    f(m, x1, t=ts, x0=x0)
    assert len(m.ts) == 1, f"Model bị gọi {len(m.ts)} lần, cần đúng một lần."
    got = m.ts[0]
    assert got.shape == (4,), f"Model nhận t shape {tuple(got.shape)}, cần (B,) = (4,): phiên bản t đã đổi shape (B, 1, 1, 1) chỉ để nhân với ảnh, không phải để đưa cho model."
    assert got.dtype == torch.float32 and torch.equal(got, ts), f"Model nhận t = {got.tolist()}, cần đúng {ts.tolist()}."


def test_default_t(user, ref):
    """t tự lấy: mỗi mẫu một số đều trong [0, 1) (float32, shape (B,)), không phải Gauss hay số nguyên, và khác nhau giữa các mẫu"""
    f = need(user, "fm_loss")
    x1 = torch.zeros(1024, 1, 2, 2)
    m = _Rec()
    t.seed(1)
    for _ in range(3):
        f(m, x1)
    for ts in m.ts:
        assert ts.shape == (1024,) and ts.is_floating_point(), f"t đưa cho model có shape {tuple(ts.shape)}, kiểu {ts.dtype}: cần số thực shape (B,) = (1024,), mỗi mẫu một t."
        assert float(ts.min()) >= 0.0 and float(ts.max()) <= 1.0, f"t tự lấy nằm ngoài [0, 1] (nhỏ nhất {float(ts.min()):.3f}, lớn nhất {float(ts.max()):.3f}): thời gian trên đường đi chạy từ 0 đến 1, hàm sinh số của bạn phải cho giá trị đều trong khoảng đó."
        assert float(ts.min()) < 0.05 and float(ts.max()) > 0.95 and abs(float(ts.mean()) - 0.5) < 0.05, f"t tự lấy không giống phân phối đều trên [0, 1) (nhỏ nhất {float(ts.min()):.3f}, lớn nhất {float(ts.max()):.3f}, trung bình {float(ts.mean()):.3f})."


def test_default_noise(user, ref):
    """x0 tự lấy ~ N(0, I): với x1 = 0 và mô hình luôn đoán 0, loss bằng trung bình x0² ≈ 1"""
    f = need(user, "fm_loss")
    x1 = torch.zeros(1024, 1, 2, 2)
    t.seed(2)
    got = float(f(_Rec(), x1))
    assert abs(got - 1.0) < 0.1, f"Với x1 = 0 và mô hình đoán 0 loss là {got:.3f}, đáng lẽ khoảng 1 (đích là −x0 với x0 ~ N(0, 1)). Nhiễu x0 của bạn lấy từ phân phối nào, và có shape của x1 không?"


def test_gradient(user, ref):
    """Gradient chảy về tham số của model và khớp lời giải chuẩn (không detach, trung bình chứ không tổng)"""
    x1 = torch.randn(4, 6, generator=_g(5))
    x0 = torch.randn(4, 6, generator=_g(15))
    ts = torch.rand(4, generator=_g(25))

    def run(fn):
        t.seed(40)
        m = _Net((6,))
        loss = fn(m, x1, ts, x0)
        assert loss.requires_grad, "Loss không có gradient (requires_grad = False): có chỗ nào cắt đường gradient từ loss về tham số của model (detach, item, no_grad) không?"
        loss.backward()
        return [p.grad.clone() for p in m.parameters()]

    gu = run(need(user, "fm_loss"))
    gr = run(ref["fm_loss"])
    for i, (a, b) in enumerate(zip(gu, gr)):
        t.close(a, b, tol=1e-5, what=f"gradient của tham số thứ {i + 1} của model")
