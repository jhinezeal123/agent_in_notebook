def _g(seed):
    return torch.Generator().manual_seed(seed)


class _Tiny(nn.Module):
    """Mô hình giả có tham số: một conv 3x3 cộng một embedding theo bước t (cần t kiểu int64, shape (B,))."""

    def __init__(self, T=100, C=3):
        super().__init__()
        self.conv = nn.Conv2d(C, C, 3, padding=1)
        self.emb = nn.Embedding(T, C)

    def forward(self, x, ts):
        assert torch.is_tensor(ts) and ts.dtype == torch.long and ts.shape == (x.shape[0],), f"Mô hình nhận t có kiểu/shape {getattr(ts, 'dtype', type(ts))}/{tuple(getattr(ts, 'shape', ()))}, cần tensor int64 shape (B,) = ({x.shape[0]},)."
        return self.conv(x) + self.emb(ts).view(-1, x.shape[1], 1, 1)


def _tiny(seed):
    t.seed(seed)
    return _Tiny()


class _Rec(nn.Module):
    """Mô hình giả luôn đoán 0 và ghi lại mọi (x_t, t) nó được gọi với."""

    def __init__(self):
        super().__init__()
        self.xs, self.ts = [], []

    def forward(self, x, ts):
        assert torch.is_tensor(ts), "Mô hình nhận t không phải tensor: cần tensor int64 shape (B,)."
        self.xs.append(x.detach().clone())
        self.ts.append(ts.detach().clone())
        return torch.zeros_like(x)


class _Oracle(nn.Module):
    """Mô hình giả biết x0: đoán đúng nhiễu đã thêm vào x_t, miễn là được gọi với đúng bước t của x_t."""

    def __init__(self, x0, sched):
        super().__init__()
        self.x0, self.s = x0, sched

    def forward(self, x, ts):
        assert torch.is_tensor(ts) and ts.dtype == torch.long and ts.shape == (x.shape[0],), "Mô hình nhận t không phải tensor int64 shape (B,)."
        sab = self.s["sqrt_alpha_bar"][ts].view(-1, 1, 1, 1)
        s1m = self.s["sqrt_one_minus_alpha_bar"][ts].view(-1, 1, 1, 1)
        return (x - sab * self.x0) / s1m


def test_loss_value(user, ref):
    """Với t và noise cho sẵn: một số (shape ()) bằng trung bình, trên mọi phần tử, của bình phương sai khác giữa dự đoán của model và noise"""
    f = need(user, "ddpm_loss")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(4, 3, 5, 5, generator=_g(1))
    noise = torch.randn(4, 3, 5, 5, generator=_g(2))
    ts = torch.tensor([0, 17, 60, 99])
    m = _tiny(3)
    got = f(m, x0, sched, t=ts, noise=noise)
    t.shape(got, (), what="ddpm_loss (một số, không phải tensor nhiều phần tử)")
    sab = sched["sqrt_alpha_bar"][ts].view(-1, 1, 1, 1)
    s1m = sched["sqrt_one_minus_alpha_bar"][ts].view(-1, 1, 1, 1)
    xt = sab * x0 + s1m * noise
    with torch.no_grad():
        want = ((m(xt, ts) - noise) ** 2).mean()
    t.close(got, want, tol=1e-5, what="ddpm_loss với t và noise cho sẵn (trung bình trên MỌI phần tử, không phải tổng)")


def test_predicts_noise(user, ref):
    """Mô hình giả biết x0 đoán đúng nhiễu thì loss ≈ 0: đích phải là nhiễu ε (không phải x0), và model phải nhận đúng t đã dùng để nhiễu ảnh"""
    f = need(user, "ddpm_loss")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(4, 3, 5, 5, generator=_g(3))
    noise = torch.randn(4, 3, 5, 5, generator=_g(4))
    ts = torch.tensor([3, 40, 77, 98])
    got = f(_Oracle(x0, sched), x0, sched, t=ts, noise=noise)
    assert float(got) < 1e-5, f"Mô hình hoàn hảo (đoán đúng nhiễu nếu được gọi với đúng x_t và t) vẫn cho loss {float(got):.4f}, đáng lẽ gần 0. Đích hồi quy là gì (nhiễu hay ảnh sạch), và t đưa vào model có đúng là t đã dùng để làm nhiễu ảnh không?"


def test_default_draws(user, ref):
    """Khi t và noise đều là None: hàm tự lấy, và nhiễu dùng để tạo x_t chính là nhiễu đích (mô hình biết x0 vẫn cho loss ≈ 0)"""
    f = need(user, "ddpm_loss")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(32, 3, 4, 4, generator=_g(5))
    t.seed(0)
    got = f(_Oracle(x0, sched), x0, sched)
    assert float(got) < 1e-4, f"Với t và noise tự sinh, mô hình biết x0 vẫn cho loss {float(got):.4f}, đáng lẽ gần 0: nhiễu dùng để tạo x_t và nhiễu dùng làm đích có phải cùng một tensor không (lấy một lần)?"


def test_noise_distribution(user, ref):
    """Nhiễu tự sinh ~ N(0, I): với mô hình luôn đoán 0 thì loss bằng trung bình ε² ≈ 1"""
    f = need(user, "ddpm_loss")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(500, 1, 4, 4, generator=_g(6))
    t.seed(1)
    got = float(f(_Rec(), x0, sched))
    assert abs(got - 1.0) < 0.1, f"Mô hình luôn đoán 0 cho loss {got:.3f}, đáng lẽ khoảng 1 (trung bình ε² của ε ~ N(0, 1)). Nhiễu của bạn lấy từ phân phối nào, và có shape của x0 không?"


def test_t_sampling(user, ref):
    """t tự lấy: mỗi ảnh một bước, kiểu int64 shape (B,), đều trên 0..T−1 (đủ cả hai đầu, không lố ra T), và khác nhau giữa các ảnh"""
    f = need(user, "ddpm_loss")
    sched = ref["make_schedule"](5)
    x0 = torch.randn(64, 1, 4, 4, generator=_g(7))
    m = _Rec()
    t.seed(2)
    for _ in range(4):
        f(m, x0, sched)
    for ts in m.ts:
        assert ts.dtype == torch.long and ts.shape == (64,), f"t đưa cho model có kiểu {ts.dtype} shape {tuple(ts.shape)}, cần int64 shape (B,) = (64,): mỗi ảnh một bước."
        assert len(set(ts.tolist())) > 1, "Cả batch dùng cùng một t: mỗi ảnh phải có bước ngẫu nhiên riêng."
    allt = torch.cat(m.ts)
    assert int(allt.min()) == 0, f"Trong 256 lần lấy t với T = 5 không thấy t = 0 (nhỏ nhất là {int(allt.min())}): đầu dưới của khoảng là bước nào?"
    assert int(allt.max()) == 4, f"Trong 256 lần lấy t với T = 5 không thấy t = 4 (lớn nhất là {int(allt.max())}): đầu trên của khoảng, bước cuối T−1, có được lấy không?"


def test_model_receives(user, ref):
    """Model được gọi đúng một lần với x_t = √ᾱ·x0 + √(1−ᾱ)·ε và đúng t đã cho"""
    f = need(user, "ddpm_loss")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(4, 3, 5, 5, generator=_g(8))
    noise = torch.randn(4, 3, 5, 5, generator=_g(9))
    ts = torch.tensor([5, 25, 55, 90])
    m = _Rec()
    f(m, x0, sched, t=ts, noise=noise)
    assert len(m.xs) == 1, f"Model bị gọi {len(m.xs)} lần, cần đúng một lần."
    xt = sched["sqrt_alpha_bar"][ts].view(-1, 1, 1, 1) * x0 + sched["sqrt_one_minus_alpha_bar"][ts].view(-1, 1, 1, 1) * noise
    t.close(m.xs[0], xt, tol=1e-5, what="x_t mà model nhận (ảnh nhiễu theo Eq. 4 với t và noise đã cho)")
    assert torch.equal(m.ts[0], ts), f"Model nhận t = {m.ts[0].tolist()}, cần đúng {ts.tolist()}: t đưa cho model phải là t đã dùng để tạo x_t, không được đổi."


def test_gradient(user, ref):
    """Gradient chảy về tham số của model và khớp lời giải chuẩn (loss không bị detach, không bị cộng thay vì trung bình)"""
    sched = ref["make_schedule"](100)
    x0 = torch.randn(4, 3, 5, 5, generator=_g(10))
    noise = torch.randn(4, 3, 5, 5, generator=_g(11))
    ts = torch.tensor([2, 33, 66, 97])

    def run(fn):
        m = _tiny(12)
        loss = fn(m, x0, sched, ts, noise)
        assert loss.requires_grad, "Loss không có gradient (requires_grad = False): có chỗ nào cắt đường gradient từ loss về tham số của model (detach, item, no_grad) không?"
        loss.backward()
        return [p.grad.clone() for p in m.parameters()]

    gu = run(need(user, "ddpm_loss"))
    gr = run(ref["ddpm_loss"])
    for i, (a, b) in enumerate(zip(gu, gr)):
        t.close(a, b, tol=1e-5, what=f"gradient của tham số thứ {i + 1} của model")
