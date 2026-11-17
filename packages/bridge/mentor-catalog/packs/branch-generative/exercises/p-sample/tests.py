def _g(seed):
    return torch.Generator().manual_seed(seed)


class _Oracle(nn.Module):
    """Mô hình giả biết x0: đoán đúng nhiễu đã thêm vào x_t, miễn là được gọi với đúng bước t. Ghi lại các t đã nhận."""

    def __init__(self, x0, sched):
        super().__init__()
        self.x0, self.s = x0, sched
        self.calls = []

    def forward(self, x, ts):
        assert torch.is_tensor(ts) and ts.dtype == torch.long and ts.shape == (x.shape[0],), f"Mô hình nhận t có kiểu/shape {getattr(ts, 'dtype', type(ts))}/{tuple(getattr(ts, 'shape', ()))}, cần tensor int64 shape (B,) = ({x.shape[0]},) chứa bước t."
        self.calls.append(ts.detach().clone())
        sab = self.s["sqrt_alpha_bar"][ts].view(-1, 1, 1, 1)
        s1m = self.s["sqrt_one_minus_alpha_bar"][ts].view(-1, 1, 1, 1)
        return (x - sab * self.x0) / s1m


class _Tiny(nn.Module):
    """Mô hình giả có tham số: conv 3x3 cộng embedding theo bước t (cần t int64 shape (B,))."""

    def __init__(self, T=100, C=1):
        super().__init__()
        self.conv = nn.Conv2d(C, C, 3, padding=1)
        self.emb = nn.Embedding(T, C)

    def forward(self, x, ts):
        assert torch.is_tensor(ts) and ts.dtype == torch.long and ts.shape == (x.shape[0],), "Mô hình nhận t không phải tensor int64 shape (B,)."
        return self.conv(x) + self.emb(ts).view(-1, x.shape[1], 1, 1)


def _noisy(sched, x0, k, eps):
    """x_t theo Eq. 4 tại bước k (số nguyên), tính bằng hệ số của lịch."""
    return float(sched["sqrt_alpha_bar"][k]) * x0 + float(sched["sqrt_one_minus_alpha_bar"][k]) * eps


def _posterior_mean(x0, xt, k, T):
    """Trung bình hậu nghiệm q(x_{t-1} | x_t, x0) (Eq. 7), tính từ đầu bằng float64: không dùng công thức của Alg. 2."""
    b = np.linspace(1e-4, 0.02, T, dtype=np.float64)
    ab = np.cumprod(1.0 - b)
    ab_prev = float(ab[k - 1]) if k > 0 else 1.0
    c0 = float(np.sqrt(ab_prev) * b[k] / (1.0 - ab[k]))
    ct = float(np.sqrt(1.0 - b[k]) * (1.0 - ab_prev) / (1.0 - ab[k]))
    return (c0 * x0.double() + ct * xt.double()).float()


def test_posterior_mean(user, ref):
    """Mô hình giả đoán đúng nhiễu, z = 0: x_(t−1) bằng trung bình hậu nghiệm của q(x_(t−1) | x_t, x0) (Eq. 7), ở t = 1, 30, 99"""
    f = need(user, "p_sample")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(4, 1, 3, 3, generator=_g(1))
    eps = torch.randn(4, 1, 3, 3, generator=_g(2))
    for k in (1, 30, 99):
        xt = _noisy(sched, x0, k, eps)
        got = f(_Oracle(x0, sched), xt, k, sched, noise=torch.zeros_like(xt))
        t.close(got, _posterior_mean(x0, xt, k, 100), tol=1e-4, what=f"x_(t−1) tại t = {k} khi mô hình đoán đúng nhiễu và z = 0 (phải bằng trung bình hậu nghiệm: kiểm lại 1/√α_t, hệ số của ε_θ và chỉ số t)")


def test_last_step_no_noise(user, ref):
    """Bước cuối t = 0 không thêm nhiễu: với mô hình đoán đúng nhiễu kết quả là đúng x0, dù noise đưa vào khác 0; noise = None cho kết quả tất định"""
    f = need(user, "p_sample")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(4, 1, 3, 3, generator=_g(3))
    eps = torch.randn(4, 1, 3, 3, generator=_g(4))
    xt = _noisy(sched, x0, 0, eps)
    got = f(_Oracle(x0, sched), xt, 0, sched, noise=torch.full_like(xt, 5.0))
    t.close(got, x0, tol=1e-4, what="x_(−1) ở t = 0 với mô hình đoán đúng nhiễu (phải là x0, không cộng thêm σ·z kể cả khi noise đưa vào khác 0)")
    t.seed(1)
    a = f(_Oracle(x0, sched), xt, 0, sched)
    t.seed(2)
    b = f(_Oracle(x0, sched), xt, 0, sched)
    assert torch.equal(a, b), "Ở t = 0 với noise = None, hai lần chạy khác seed cho hai kết quả khác nhau: bước cuối phải tất định (không thêm nhiễu)."
    mid = _noisy(sched, x0, 50, eps)
    t.seed(1)
    c = f(_Oracle(x0, sched), mid, 50, sched)
    t.seed(2)
    d = f(_Oracle(x0, sched), mid, 50, sched)
    assert not torch.allclose(c, d), "Ở t > 0 với noise = None, hai lần chạy khác seed cho cùng một kết quả: các bước khác phải cộng thêm nhiễu ngẫu nhiên σ_t·z."


def test_noise_scale(user, ref):
    """Nhiễu thêm vào là σ_t·z với σ_t² = β_t (σ_t = √β_t): đo bằng hiệu giữa chạy có z và chạy z = 0; noise = None lấy N(0, I)"""
    f = need(user, "p_sample")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(4, 1, 3, 3, generator=_g(5))
    eps = torch.randn(4, 1, 3, 3, generator=_g(6))
    for k in (99, 40, 1):
        xt = _noisy(sched, x0, k, eps)
        z = torch.randn(4, 1, 3, 3, generator=_g(7 + k))
        base = f(_Oracle(x0, sched), xt, k, sched, noise=torch.zeros_like(xt))
        out = f(_Oracle(x0, sched), xt, k, sched, noise=z)
        sigma = float(torch.sqrt(sched["betas"][k]))
        t.close(out - base, sigma * z, tol=1e-5, what=f"phần nhiễu thêm vào ở t = {k} (phải là √β_t · z, β_t = {float(sched['betas'][k]):.4g})")
    big = ref["make_schedule"](1000)
    x0 = torch.randn(2000, 1, 4, 4, generator=_g(8))
    eps = torch.randn(2000, 1, 4, 4, generator=_g(9))
    xt = _noisy(big, x0, 999, eps)
    base = f(_Oracle(x0, big), xt, 999, big, noise=torch.zeros_like(xt))
    t.seed(3)
    out = f(_Oracle(x0, big), xt, 999, big)
    res = (out - base) / float(torch.sqrt(big["betas"][999]))
    assert abs(float(res.std()) - 1.0) < 0.03 and abs(float(res.mean())) < 0.03, f"Khi noise = None, phần nhiễu thêm vào (chia cho √β_t) có độ lệch chuẩn {float(res.std()):.3f} và trung bình {float(res.mean()):.3f}, cần xấp xỉ 1 và 0: nhiễu phải lấy từ N(0, I) cùng shape với x_t."


def test_model_call(user, ref):
    """Model được gọi đúng một lần, với x_t nguyên vẹn và t_batch là tensor int64 shape (B,) toàn giá trị t"""
    f = need(user, "p_sample")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(3, 1, 3, 3, generator=_g(10))
    eps = torch.randn(3, 1, 3, 3, generator=_g(11))
    xt = _noisy(sched, x0, 7, eps)
    m = _Oracle(x0, sched)
    f(m, xt, 7, sched, noise=torch.zeros_like(xt))
    assert len(m.calls) == 1, f"Model bị gọi {len(m.calls)} lần trong một bước reverse, cần đúng một lần."
    assert torch.equal(m.calls[0], torch.full((3,), 7, dtype=torch.long)), f"Model nhận t_batch = {m.calls[0].tolist()}, cần toàn giá trị 7 (bước hiện tại, không đổi, đủ một phần tử cho mỗi ảnh)."


def test_full_chain(user, ref):
    """Chạy cả chuỗi t = T−1 về 0 (Alg. 2) từ nhiễu thuần tuý với mô hình giả đoán đúng nhiễu: ra đúng x0 (nhờ bước cuối không có nhiễu)"""
    f = need(user, "p_sample")
    sched = ref["make_schedule"](20)
    x0 = torch.randn(3, 1, 4, 4, generator=_g(12))
    m = _Oracle(x0, sched)
    x = torch.randn(3, 1, 4, 4, generator=_g(13))
    t.seed(5)
    for k in range(19, -1, -1):
        x = f(m, x, k, sched)
    assert len(m.calls) == 20, f"Model bị gọi {len(m.calls)} lần cho 20 bước, cần đúng 20."
    t.close(x, x0, tol=1e-3, what="ảnh cuối của chuỗi reverse với mô hình đoán đúng nhiễu (phải về x0; nếu còn lệch cỡ 0.01 thì bước cuối còn thêm nhiễu)")


def test_shape_and_inputs(user, ref):
    """Trả về cùng shape và kiểu float32 với x_t, và không sửa x_t của người gọi (ở t = 0 và t > 0)"""
    f = need(user, "p_sample")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(4, 1, 3, 3, generator=_g(14))
    eps = torch.randn(4, 1, 3, 3, generator=_g(15))
    for k in (0, 50):
        xt = _noisy(sched, x0, k, eps)
        keep = xt.clone()
        out = f(_Oracle(x0, sched), xt, k, sched, noise=torch.randn(4, 1, 3, 3, generator=_g(16)))
        t.shape(out, (4, 1, 3, 3), what=f"p_sample tại t = {k}")
        assert out.dtype == torch.float32, f"Kết quả có kiểu {out.dtype}, cần torch.float32."
        assert torch.equal(xt, keep), f"p_sample đã sửa x_t của người gọi tại chỗ (ở t = {k}): hãy tạo tensor mới (vòng lặp lấy mẫu còn dùng lại x_t)."


def test_arbitrary_model(user, ref):
    """Với một mô hình đoán nhiễu bất kỳ (có tham số), trên lịch nhiễu của chính bạn: khớp lời giải chuẩn ở t = 0, 10, 99 với cùng z"""
    f = need(user, "p_sample")
    mine = need(user, "make_schedule")(100)
    sched = ref["make_schedule"](100)
    t.seed(20)
    m = _Tiny()
    for k in (0, 10, 99):
        xt = torch.randn(4, 1, 5, 5, generator=_g(21 + k))
        z = torch.randn(4, 1, 5, 5, generator=_g(22 + k))
        with torch.no_grad():
            want = ref["p_sample"](m, xt, k, sched, noise=z)
            got = f(m, xt, k, mine, noise=z)
        t.close(got, want, tol=1e-5, what=f"p_sample tại t = {k} với mô hình đoán nhiễu bất kỳ")
