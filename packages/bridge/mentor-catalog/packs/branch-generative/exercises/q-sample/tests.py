def _g(seed):
    return torch.Generator().manual_seed(seed)


def _expected(x0, ts, noise, sched):
    """Đáp án độc lập với lời giải: tính từng ảnh một bằng vòng lặp, hệ số lấy theo bước của chính ảnh đó."""
    out = torch.empty_like(x0)
    for i in range(x0.shape[0]):
        k = int(ts[i])
        a = float(sched["sqrt_alpha_bar"][k])
        b = float(sched["sqrt_one_minus_alpha_bar"][k])
        out[i] = a * x0[i] + b * noise[i]
    return out


def test_shape_and_inputs(user, ref):
    """Trả về (B, C, H, W) float32, và không sửa x0, noise, t của người gọi"""
    f = need(user, "q_sample")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(4, 3, 5, 6, generator=_g(1))
    noise = torch.randn(4, 3, 5, 6, generator=_g(2))
    ts = torch.tensor([0, 37, 5, 99])
    x0c, nc, tc = x0.clone(), noise.clone(), ts.clone()
    out = f(x0, ts, noise, sched)
    t.shape(out, (4, 3, 5, 6), what="q_sample với x0 (4, 3, 5, 6) và t (4,)")
    assert out.dtype == torch.float32, f"Kết quả có kiểu {out.dtype}, cần torch.float32."
    assert torch.equal(x0, x0c), "q_sample đã sửa x0 của người gọi tại chỗ (nhân hay cộng trực tiếp lên x0): hãy tạo tensor mới."
    assert torch.equal(noise, nc), "q_sample đã sửa noise của người gọi tại chỗ: hãy tạo tensor mới."
    assert torch.equal(ts, tc), "q_sample đã sửa t của người gọi tại chỗ."


def test_values_per_sample(user, ref):
    """Mỗi ảnh dùng hệ số của đúng bước t của nó (các t khác nhau trong batch, gồm cả 0 và T−1), khớp tính từng ảnh một"""
    f = need(user, "q_sample")
    sched = ref["make_schedule"](100)
    x0 = torch.randn(4, 3, 5, 6, generator=_g(3))
    noise = torch.randn(4, 3, 5, 6, generator=_g(4))
    for tv in ([0, 37, 5, 99], [50, 50, 50, 50], [99, 0, 1, 98]):
        ts = torch.tensor(tv)
        want = _expected(x0, ts, noise, sched)
        t.close(f(x0, ts, noise, sched), want, tol=1e-5, what=f"q_sample với t = {tv} (mỗi ảnh một bước, hệ số lấy theo t[b])")


def test_batch_axis(user, ref):
    """Hệ số theo t chạy dọc trục batch (không phải trục kênh hay trục chiều rộng), kể cả khi B trùng với C hay W"""
    f = need(user, "q_sample")
    sched = ref["make_schedule"](100)
    for shape, tv in [((3, 3, 4, 5), [2, 50, 97]), ((4, 2, 3, 4), [1, 30, 60, 98])]:
        x0 = torch.randn(*shape, generator=_g(5))
        noise = torch.randn(*shape, generator=_g(6))
        ts = torch.tensor(tv)
        want = _expected(x0, ts, noise, sched)
        t.close(f(x0, ts, noise, sched), want, tol=1e-5, what=f"q_sample với shape {shape} (B trùng với C hoặc W: broadcasting lệch trục sẽ không báo lỗi mà ra số sai)")


def test_variance_preserved(user, ref):
    """Nếu x0 và noise đều ~ N(0, 1) thì x_t cũng có phương sai khoảng 1 ở mọi bước: hệ số tín hiệu và nhiễu là căn, không phải chính ᾱ"""
    f = need(user, "q_sample")
    sched = ref["make_schedule"](1000)
    x0 = torch.randn(2000, 1, 2, 2, generator=_g(7))
    noise = torch.randn(2000, 1, 2, 2, generator=_g(8))
    for tt in (100, 300, 600):
        ts = torch.full((2000,), tt, dtype=torch.long)
        v = float(f(x0, ts, noise, sched).var())
        assert 0.92 < v < 1.08, f"Ở bước {tt} phương sai của x_t là {v:.3f}, phải gần 1 (tín hiệu và nhiễu độc lập, bình phương hai hệ số cộng lại bằng 1). Hệ số nào đang thiếu hoặc thừa một phép căn?"


def test_endpoints(user, ref):
    """Bước 0 gần như chưa có nhiễu (x_t ≈ x0) và bước T−1 gần như toàn nhiễu (x_t ≈ ε); bước 0 không bị lẫn sang phần tử cuối của lịch"""
    f = need(user, "q_sample")
    sched = ref["make_schedule"](1000)
    x0 = torch.randn(4, 1, 6, 6, generator=_g(9))
    noise = torch.randn(4, 1, 6, 6, generator=_g(10))
    first = f(x0, torch.zeros(4, dtype=torch.long), noise, sched)
    assert float((first - x0).abs().max()) < 0.1, "Ở bước 0 ảnh phải gần như còn nguyên (nhiễu mới thêm rất nhỏ), nhưng kết quả xa x0: hệ số của tín hiệu và của nhiễu có đúng chỗ và đúng chỉ số không?"
    last = f(x0, torch.full((4,), 999, dtype=torch.long), noise, sched)
    assert float((last - noise).abs().max()) < 0.1, "Ở bước T−1 gần như không còn tín hiệu, x_t phải xấp xỉ nhiễu, nhưng kết quả xa noise: hệ số của tín hiệu và của nhiễu có đúng chỗ không?"


def test_with_your_schedule(user, ref):
    """Chạy được trên lịch nhiễu của chính bạn (bài noise-schedule), khớp lời giải chuẩn trên lịch chuẩn"""
    f = need(user, "q_sample")
    mine = need(user, "make_schedule")(100)
    x0 = torch.randn(3, 2, 4, 4, generator=_g(11))
    noise = torch.randn(3, 2, 4, 4, generator=_g(12))
    ts = torch.tensor([3, 60, 99])
    want = ref["q_sample"](x0, ts, noise, ref["make_schedule"](100))
    t.close(f(x0, ts, noise, mine), want, tol=1e-5, what="q_sample dùng lịch nhiễu của bạn")
