T_STEPS = 8
SHAPE = (3, 1, 4, 4)


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _sched(ref):
    return ref["make_schedule"](T_STEPS, 0.05, 0.4)


class _Fake(nn.Module):
    """Mô hình giả tất định: ghi lại mọi lần được gọi (x, t, chế độ train/eval, có đang tính gradient không)."""

    def __init__(self):
        super().__init__()
        self.w = nn.Parameter(torch.tensor(0.3))
        self.calls = []

    def forward(self, x, t):
        self.calls.append({"x": x.detach().clone(), "t": t.detach().clone(), "training": self.training, "grad": torch.is_grad_enabled()})
        return torch.tanh(x * self.w) + 0.02 * t.float().view(-1, 1, 1, 1)


class _Oracle(nn.Module):
    """Mô hình giả "biết trước ảnh sạch" X0: đoán nhiễu chính xác tại mọi (x_t, t)."""

    def __init__(self, x0, sched):
        super().__init__()
        self.w = nn.Parameter(torch.zeros(()))
        self.x0, self.sched = x0, sched

    def forward(self, x, t):
        s = self.sched["sqrt_alpha_bar"][t].view(-1, 1, 1, 1)
        n = self.sched["sqrt_one_minus_alpha_bar"][t].view(-1, 1, 1, 1)
        return (x - s * self.x0) / n + 0.0 * self.w


def _run(ns, model, sched, seed=3):
    return need(ns, "sample")(model, sched, SHAPE, generator=_g(seed))


def test_shape_dtype(user, ref):
    """sample trả về tensor float32 đúng shape (B, C, H, W) và hữu hạn"""
    out = _run(user, _Fake(), _sched(ref))
    assert isinstance(out, torch.Tensor), "sample phải trả về một tensor (ảnh x_0)."
    t.shape(out, SHAPE, what="ảnh sinh ra")
    assert out.dtype == torch.float32, f"Ảnh sinh ra có dtype {out.dtype}, cần float32."
    assert bool(torch.isfinite(out).all()), "Ảnh sinh ra có NaN hoặc inf."


def test_every_step(user, ref):
    """Mô hình được gọi đúng T lần, mỗi bước một lần, theo thứ tự t = T-1, ..., 1, 0, với t_batch int64 (B,) toàn giá trị t"""
    model = _Fake()
    _run(user, model, _sched(ref))
    got = [c["t"] for c in model.calls]
    assert len(got) == T_STEPS, f"Mô hình được gọi {len(got)} lần, cần đúng {T_STEPS} lần (mỗi bước reverse một lần: từ t = T-1 về tới t = 0, cả hai đầu)."
    for i, tb in enumerate(got):
        want = T_STEPS - 1 - i
        assert tb.dtype == torch.int64 and tuple(tb.shape) == (SHAPE[0],), f"Lần gọi thứ {i + 1}: t_batch có dtype {tb.dtype}, shape {tuple(tb.shape)}; cần int64 (B,)."
        assert bool((tb == want).all()), f"Lần gọi thứ {i + 1} có t = {tb.tolist()}, cần toàn {want}: vòng lặp phải đi từ nhiễu nhiều nhất (t = T-1) về ảnh sạch (t = 0)."


def test_starts_from_noise(user, ref):
    """Ảnh khởi đầu x_T là N(0, I) lấy từ generator (lần lấy đầu tiên), không phải ảnh toàn 0 hay lấy sau các nhiễu khác"""
    model = _Fake()
    _run(user, model, _sched(ref), seed=11)
    want = torch.randn(SHAPE, generator=_g(11))
    assert len(model.calls) > 0, "Mô hình chưa được gọi lần nào."
    first = model.calls[0]["x"]
    assert float(first.abs().max()) > 0, "Ảnh đưa vào mô hình ở bước đầu toàn 0: thuật toán bắt đầu từ đâu?"
    t.close(first, want, what="ảnh đưa vào mô hình ở bước đầu (phải là x_T = torch.randn(shape, generator=generator), lần lấy nhiễu đầu tiên)")


def test_matches_reference(user, ref):
    """Cùng generator, mô hình giả và lịch nhiễu: kết quả khớp lời giải chuẩn (nhiễu z mới ở mỗi bước t > 0, đúng thứ tự lấy)"""
    sched = _sched(ref)
    got = _run(user, _Fake(), sched, seed=5)
    want = _run(ref, _Fake(), sched, seed=5)
    t.close(got, want, tol=1e-4, what="ảnh sinh ra (mỗi bước có nhiễu z riêng, lấy từ generator theo thứ tự x_T, rồi z của t = T-1, T-2, ...; truyền cho p_sample qua noise)")


def test_oracle_returns_clean_image(user, ref):
    """Nếu mô hình đoán nhiễu chính xác (biết ảnh sạch), bước cuối trả về đúng ảnh sạch: không thêm nhiễu và không cắt giá trị"""
    sched = _sched(ref)
    x0 = torch.linspace(-2.0, 2.0, 16).view(1, 1, 4, 4).repeat(SHAPE[0], 1, 1, 1)
    out = _run(user, _Oracle(x0, sched), sched, seed=7)
    t.close(out, x0, tol=1e-3, what="ảnh sinh ra với mô hình biết trước ảnh sạch (giá trị trong [-2, 2]; bước cuối t = 0 phải ra đúng ảnh sạch)")


def test_no_grad(user, ref):
    """Sinh ảnh không tính gradient: ảnh trả về không dính đồ thị tính toán, và mô hình không bị gọi khi gradient đang bật"""
    model = _Fake()
    out = _run(user, model, _sched(ref))
    assert not out.requires_grad, "Ảnh sinh ra có requires_grad = True: sinh ảnh là suy luận, bọc vòng lặp trong chế độ không gradient (tốn bộ nhớ T lần nếu không)."
    assert not any(c["grad"] for c in model.calls), "Mô hình bị gọi khi gradient đang bật: sinh ảnh phải chạy không gradient."


def test_eval_mode(user, ref):
    """Mô hình ở chế độ eval trong lúc sinh, và sau khi sinh xong trở về đúng chế độ trước đó (train hay eval)"""
    for before in (True, False):
        model = _Fake()
        model.train(before)
        _run(user, model, _sched(ref))
        assert model.calls and not any(c["training"] for c in model.calls), "Mô hình đang ở chế độ train trong lúc sinh ảnh (dropout, batchnorm sẽ làm hỏng mẫu): chuyển sang eval."
        assert model.training == before, f"Trước khi sinh mô hình có training = {before}, sau khi sinh là {model.training}: hàm phải trả mô hình về đúng chế độ cũ."
