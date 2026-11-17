def _g(seed):
    return torch.Generator().manual_seed(seed)


def _check_t(x, ts):
    assert torch.is_tensor(ts) and ts.is_floating_point() and ts.shape == (x.shape[0],), f"Mô hình nhận t có kiểu/shape {getattr(ts, 'dtype', type(ts))}/{tuple(getattr(ts, 'shape', ()))}, cần tensor số thực shape (B,) = ({x.shape[0]},): một giá trị t_k cho mỗi mẫu."


class _Field:
    """Mô hình giả là một trường vận tốc giải tích v(x, t); ghi lại mọi lần gọi: (x, t, có đang ghi gradient)."""

    def __init__(self, fn):
        self.fn = fn
        self.calls = []

    def __call__(self, x, ts):
        _check_t(x, ts)
        self.calls.append((x.detach().clone(), ts.detach().clone(), torch.is_grad_enabled()))
        return self.fn(x, ts.view(-1, *([1] * (x.dim() - 1))))


class _Scale(nn.Module):
    """Mô hình giả có một tham số học được w = −1: v(x, t) = w·x. Ghi lại việc gradient có đang bật khi được gọi."""

    def __init__(self):
        super().__init__()
        self.w = nn.Parameter(torch.tensor(-1.0))
        self.flags = []

    def forward(self, x, ts):
        _check_t(x, ts)
        self.flags.append(torch.is_grad_enabled())
        return self.w * x


def _decay(x, tb):
    return -x


def test_state_field(user, ref):
    """Trường chỉ phụ thuộc vào x (v = −x): sau N bước Euler, x = x0·(1 − 1/N)^N chính xác, với N = 1, 2, 7"""
    f = need(user, "euler_sample")
    x0 = torch.tensor([[1.0, -2.0], [0.5, 3.0]])
    for n in (1, 2, 7):
        got = f(_Field(_decay), x0, n)
        t.close(got, x0 * (1 - 1.0 / n) ** n, tol=1e-6, what=f"euler_sample với v = −x và {n} bước (mỗi bước x ← x + dt·v, dt = 1/{n})")


def test_time_field(user, ref):
    """Trường chỉ phụ thuộc vào t (v = t): Euler cộng Σ t_k·dt = (N − 1)/(2N) với t_k = k/N (vận tốc ở ĐẦU mỗi bước), với x0 shape (B, D) và (B, C, H, W)"""
    f = need(user, "euler_sample")
    for k, shape in enumerate([(3, 2), (2, 1, 3, 3)]):
        x0 = torch.randn(*shape, generator=_g(1 + k))
        for n in (5, 10):
            got = f(_Field(lambda x, tb: tb * torch.ones_like(x)), x0, n)
            want = x0 + (n - 1) / (2.0 * n)
            t.close(got, want, tol=1e-6, what=f"euler_sample với v = t, shape {shape}, {n} bước: tổng Σ t_k·dt phải là (N − 1)/(2N), kiểm lại t_k là đầu hay cuối bước và k chạy từ đâu")


def test_calls_and_times(user, ref):
    """Model được gọi đúng steps lần, với t = 0, 1/N, ..., (N−1)/N (shape (B,)) và x là trạng thái hiện tại ở mỗi lần gọi"""
    f = need(user, "euler_sample")
    x0 = torch.randn(3, 2, generator=_g(3))
    m = _Field(_decay)
    f(m, x0, 4)
    assert len(m.calls) == 4, f"Model bị gọi {len(m.calls)} lần cho steps = 4, cần đúng 4 lần (mỗi bước một lần)."
    for k, (x, ts, _) in enumerate(m.calls):
        t.close(ts, torch.full((3,), k / 4), tol=1e-6, what=f"t đưa cho model ở lần gọi thứ {k + 1} (phải là {k}/4: thời gian ở ĐẦU bước)")
    t.close(m.calls[0][0], x0, tol=1e-6, what="x ở lần gọi đầu tiên (phải là x0)")
    t.close(m.calls[1][0], x0 * 0.75, tol=1e-6, what="x ở lần gọi thứ hai (sau một bước Euler với v = −x)")
    m1 = _Field(_decay)
    f(m1, x0, 1)
    assert len(m1.calls) == 1, f"Với steps = 1 model bị gọi {len(m1.calls)} lần, cần đúng một lần."
    t.close(m1.calls[0][1], torch.zeros(3), tol=1e-7, what="t ở bước duy nhất khi steps = 1 (phải là 0)")


def test_no_inplace_dtype(user, ref):
    """Không sửa x0 tại chỗ, trả về tensor mới (không phải chính x0), và giữ nguyên kiểu số của x0 (float32 và float64)"""
    f = need(user, "euler_sample")
    for dtype in (torch.float32, torch.float64):
        x0 = torch.tensor([[1.0, 2.0], [3.0, 4.0]], dtype=dtype)
        keep = x0.clone()
        out = f(_Field(_decay), x0, 4)
        assert torch.equal(x0, keep), f"euler_sample đã sửa x0 của người gọi tại chỗ (kiểu {dtype}): hãy tạo tensor mới cho trạng thái thay vì cập nhật x0."
        assert out is not x0, "euler_sample trả về chính tensor x0: phải trả về một tensor mới."
        assert out.dtype == dtype, f"Kết quả có kiểu {out.dtype} nhưng x0 có kiểu {dtype}: phải giữ nguyên kiểu số của x0."
        t.shape(out, (2, 2), what="kết quả của euler_sample")


def test_no_grad(user, ref):
    """Suy luận không ghi gradient: kết quả không có requires_grad và gradient đang tắt mỗi khi model được gọi (dù model có tham số học được)"""
    f = need(user, "euler_sample")
    m = _Scale()
    x0 = torch.ones(2, 3)
    out = f(m, x0, 5)
    assert len(m.flags) == 5 and not any(m.flags), "Gradient đang BẬT khi model được gọi trong euler_sample: lấy mẫu là suy luận, đồ thị gradient qua nhiều bước chỉ tốn bộ nhớ. Bọc vòng lặp trong một ngữ cảnh tắt gradient."
    assert not out.requires_grad, "Kết quả có requires_grad = True: lấy mẫu không được nối vào đồ thị gradient."
    t.close(out, x0 * (1 - 1.0 / 5) ** 5, tol=1e-6, what="euler_sample với mô hình có tham số (v = w·x, w = −1) và 5 bước")


def test_converges_first_order(user, ref):
    """Sai số so với nghiệm chính xác x0·e^(−1) của dx/dt = −x giảm khoảng một nửa mỗi khi gấp đôi số bước (Euler bậc một)"""
    f = need(user, "euler_sample")
    x0 = torch.tensor([[1.0], [-2.0]])
    exact = x0 * float(np.exp(-1.0))
    errs = [float((f(_Field(_decay), x0, n) - exact).abs().max()) for n in (10, 20, 40, 80)]
    for a, b in zip(errs[:-1], errs[1:]):
        r = b / a
        assert 0.42 < r < 0.58, f"Sai số theo số bước N = 10, 20, 40, 80 là {[round(e, 5) for e in errs]}: gấp đôi N phải làm sai số giảm khoảng một nửa (tỉ số {r:.2f}), vì Euler có sai số cỡ dt."


def test_straight_field(user, ref):
    """Trường vận tốc v = (c − x)/(1 − t) của các đường thẳng tới điểm c: Euler đúng (vận tốc đo ở đầu bước) về chính xác c sau bất kỳ số bước nào"""
    f = need(user, "euler_sample")
    c = torch.tensor([[1.5, -2.0]])
    x0 = torch.randn(3, 2, generator=_g(4))
    for n in (1, 4, 10):
        got = f(_Field(lambda x, tb: (c - x) / (1 - tb)), x0, n)
        assert bool(torch.isfinite(got).all()), f"Kết quả có nan hoặc inf với {n} bước: trường (c − x)/(1 − t) chia cho 0 ở t = 1, nên thời gian đưa vào model ở mọi bước phải nhỏ hơn 1. Bạn đang đưa t nào ở bước cuối?"
        t.close(got, c.expand(3, 2), tol=1e-4, what=f"euler_sample trên trường (c − x)/(1 − t) với {n} bước (phải về đúng c = (1.5, −2))")
