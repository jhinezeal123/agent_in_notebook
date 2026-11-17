N_EVAL = 128
SEED_EVAL = 2024
N_SAMPLES = 16
KEYS = ["betas", "alphas", "alpha_bar", "sqrt_alpha_bar", "sqrt_one_minus_alpha_bar"]


def _model(user):
    m = user.get("model")
    assert isinstance(m, nn.Module), "Chưa thấy biến toàn cục `model` (một nn.Module): chạy cell train và để U-Net đã train trong biến tên `model`."
    return m


def _sched(user):
    s = user.get("sched")
    assert isinstance(s, dict) and all(k in s for k in KEYS), "Chưa thấy biến toàn cục `sched` (dict từ make_schedule của bạn, đủ năm khoá): chạy cell train và để lịch nhiễu trong biến tên `sched`."
    return s


def _device(model):
    return next(model.parameters()).device


def _on(sched, device):
    return {k: v.detach().to(device=device, dtype=torch.float32) for k, v in sched.items()}


@torch.no_grad()
def _loss_by_step(user, ref):
    """L_simple của model trên 128 ảnh test cố định, tại các bước t cách đều, nhiễu cố định, chế độ eval: (danh sách t, danh sách loss)."""
    model, sched = _model(user), _sched(user)
    device = _device(model)
    sc = _on(sched, device)
    T = sc["betas"].shape[0]
    x0 = ref["load_mnist"](N_EVAL, train=False).to(device)
    gen = torch.Generator().manual_seed(SEED_EVAL)
    steps = list(range(2, T, max(1, T // 50)))
    was_training = model.training
    model.eval()
    try:
        losses = []
        for step in steps:
            noise = torch.randn(x0.shape, generator=gen).to(device)
            tb = torch.full((x0.shape[0],), step, dtype=torch.long, device=device)
            losses.append(float(ref["ddpm_loss"](model, x0, sc, t=tb, noise=noise)))
    finally:
        model.train(was_training)
    return steps, losses


def test_model_defined(user, ref):
    """Có biến model (nn.Module) gọi được như model(x_t, t) với t int64 (B,) và trả dự đoán nhiễu cùng shape với x_t"""
    model = _model(user)
    device = _device(model)
    x = torch.randn(2, 1, 32, 32, generator=torch.Generator().manual_seed(1)).to(device)
    tb = torch.tensor([0, 150], dtype=torch.long, device=device)
    was_training = model.training
    model.eval()
    try:
        with torch.no_grad():
            out = model(x, tb)
    finally:
        model.train(was_training)
    t.shape(out, (2, 1, 32, 32), what="đầu ra của model với x_t (2, 1, 32, 32) và t int64 (2,)")


def test_schedule_ends_in_noise(user, ref):
    """sched có T = 200 bước, đủ năm tensor, và là lịch của đề: ᾱ_T gần 0 để quá trình thuận kết thúc ở nhiễu thuần túy"""
    s = _sched(user)
    for k in KEYS:
        assert tuple(s[k].shape) == (200,), f"sched[\"{k}\"] có shape {tuple(s[k].shape)}, cần (200,): thí nghiệm dùng T = 200 bước."
    ab = float(s["alpha_bar"][-1])
    assert ab < 1e-3, f"ᾱ_T = {ab:.3g}: sau T bước vẫn còn sót tín hiệu của ảnh gốc, trong khi lấy mẫu bắt đầu từ nhiễu thuần túy N(0, I). Đi ít bước hơn paper thì β phải co giãn thế nào?"
    want = ref["make_schedule"](200, 5e-4, 0.1)
    for k in KEYS:
        t.close(s[k], want[k], tol=1e-3, what=f"sched[\"{k}\"] (lịch của đề: T = 200, β từ 5e-4 đến 0,1)")


def test_weights_finite(user, ref):
    """Mọi tham số của model hữu hạn: quá trình train không phát nổ thành NaN hoặc inf"""
    model = _model(user)
    bad = [name for name, p in model.named_parameters() if not bool(torch.isfinite(p).all())]
    assert not bad, f"Các tham số này có NaN hoặc inf: {bad[:3]}. Train bị phát nổ: learning rate bao nhiêu, loss có lúc nào thành NaN không?"


def test_l_simple(user, ref):
    """Đo l_simple: L_simple trung bình của model trên 128 ảnh test MNIST, 50 bước t cách đều, nhiễu cố định (cùng hai số theo t nhỏ và t lớn), chỉ đo, không train"""
    steps, losses = _loss_by_step(user, ref)
    assert all(np.isfinite(losses)), "L_simple của model không hữu hạn (NaN hoặc inf) trên dữ liệu kiểm tra."
    t.report("l_simple", float(np.mean(losses)))
    t.report("l_simple_small_t", float(np.mean([v for s, v in zip(steps, losses) if s < 20])))
    t.report("l_simple_large_t", float(np.mean([v for s, v in zip(steps, losses) if s >= 100])))


def test_samples(user, ref):
    """Sinh 16 ảnh từ nhiễu bằng sample chuẩn với model và sched của bạn: hữu hạn; đo sample_in_range và sample_mean, chỉ báo"""
    model, sched = _model(user), _sched(user)
    device = _device(model)
    x = ref["sample"](model, _on(sched, device), (N_SAMPLES, 1, 32, 32), generator=torch.Generator().manual_seed(SEED_EVAL + 1))
    assert bool(torch.isfinite(x).all()), "Ảnh sinh ra có NaN hoặc inf: model dự đoán nhiễu quá tệ, bước reverse phát nổ."
    t.report("sample_in_range", float(((x >= -1.5) & (x <= 1.5)).float().mean()))
    t.report("sample_mean", float(x.mean()))
