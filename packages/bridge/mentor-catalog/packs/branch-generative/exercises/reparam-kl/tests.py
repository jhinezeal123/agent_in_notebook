def _g(seed):
    return torch.Generator().manual_seed(seed)


def _mv(shape, seed):
    g = _g(seed)
    return torch.randn(shape, generator=g), torch.randn(shape, generator=g) * 0.8


def test_reparam_values(user, ref):
    """reparameterize với eps cho trước: z = mu + exp(logvar/2)·eps (shape 2 và 3 chiều); logvar là log của phương sai"""
    f = need(user, "reparameterize")
    mu = torch.tensor([[1.0, 2.0]])
    logvar = torch.tensor([[0.0, float(np.log(4.0))]])
    z = f(mu, logvar, torch.tensor([[1.0, 1.0]]))
    t.close(z, torch.tensor([[2.0, 4.0]]), tol=1e-5, what="z với logvar = (0, ln 4): phương sai 1 và 4 thì độ lệch chuẩn là bao nhiêu?")
    for shape in [(4, 5), (2, 3, 5)]:
        m, lv = _mv(shape, 1)
        e = torch.randn(shape, generator=_g(2))
        t.shape(f(m, lv, e), shape, what=f"z với mu shape {shape}")
        t.close(f(m, lv, e), ref["reparameterize"](m, lv, e), tol=1e-5, what=f"z với mu shape {shape}")
        t.close(f(m, lv, torch.zeros(shape)), m, tol=1e-6, what="z khi eps = 0 (phải bằng mu)")


def test_reparam_sample(user, ref):
    """eps=None: lấy mẫu N(mu, σ²) thật (trung bình và độ lệch chuẩn khớp trên 20000 mẫu), mỗi hàng một noise riêng, hai lần gọi khác nhau"""
    f = need(user, "reparameterize")
    n = 20000
    mu = torch.tensor([1.0, -2.0, 0.5]).expand(n, 3).clone()
    logvar = torch.tensor([0.0, 1.0, -2.0]).expand(n, 3).clone()
    sigma = torch.exp(0.5 * logvar[0])
    t.seed(0)
    z = f(mu, logvar)
    t.shape(z, (n, 3), what="z khi eps = None")
    m, s = z.mean(dim=0), z.std(dim=0)
    t.close(m, mu[0], tol=0.07, what="trung bình của z trên 20000 mẫu (phải gần mu; nếu lệch nhiều: mọi hàng có đang dùng chung một noise không?)")
    t.close(s, sigma, tol=0.05 * float(sigma.max()), what="độ lệch chuẩn của z trên 20000 mẫu (phải gần exp(logvar/2); noise phải độc lập giữa các hàng và có phương sai 1)")
    z2 = f(mu, logvar)
    assert not torch.equal(z, z2), "Hai lần gọi liên tiếp với eps=None cho đúng cùng z: noise phải được lấy mới mỗi lần."


def test_reparam_grad(user, ref):
    """Gradient của z theo mu và logvar (eps cố định) khớp lời giải chuẩn: ∂z/∂mu = 1, ∂z/∂logvar = ½·σ·eps"""
    f = need(user, "reparameterize")
    mu, logvar = _mv((4, 5), 3)
    eps = torch.randn((4, 5), generator=_g(4))
    t.grad_close(lambda m, l: f(m, l, eps), lambda m, l: ref["reparameterize"](m, l, eps), mu, logvar, tol=1e-5, what="gradient của z")
    m, l = mu.clone().requires_grad_(True), logvar.clone().requires_grad_(True)
    f(m, l, eps).sum().backward()
    t.close(m.grad, torch.ones_like(m), tol=1e-6, what="∂(Σz)/∂mu (mỗi phần tử của mu cộng thẳng vào z)")
    t.close(l.grad, 0.5 * torch.exp(0.5 * logvar) * eps, tol=1e-5, what="∂(Σz)/∂logvar (đạo hàm của σ = exp(logvar/2) theo logvar, nhân eps)")


def test_reparam_grad_sampled(user, ref):
    """eps=None: z vẫn nối vào đồ thị tính toán, gradient chảy về mu (bằng 1) và logvar (bằng ½·(z − mu)), không bị cắt ở bước lấy mẫu"""
    f = need(user, "reparameterize")
    mu, logvar = _mv((6, 4), 5)
    m, l = mu.clone().requires_grad_(True), logvar.clone().requires_grad_(True)
    t.seed(6)
    z = f(m, l)
    assert z.requires_grad, "z không có gradient (requires_grad = False): bước lấy mẫu đã cắt đường về mu và logvar. Lấy mẫu trực tiếp từ N(mu, σ²) khác gì tách noise ra khỏi tham số?"
    z.sum().backward()
    assert m.grad is not None and l.grad is not None, "mu hoặc logvar không nhận gradient."
    t.close(m.grad, torch.ones_like(m), tol=1e-6, what="gradient theo mu khi eps=None")
    t.close(l.grad, 0.5 * (z.detach() - mu), tol=1e-5, what="gradient theo logvar khi eps=None (bằng ½·σ·eps = ½·(z − mu))")


def test_kl_values(user, ref):
    """KL khớp giá trị tính tay (mu=1, logvar=0 cho 0.5; mu=0, logvar=ln 4 cho 0.8069) và lời giải chuẩn trên dữ liệu ngẫu nhiên"""
    f = need(user, "kl_gaussian")
    t.close(f(torch.tensor([[1.0]]), torch.tensor([[0.0]])), torch.tensor([0.5]), tol=1e-6, what="KL với mu = 1, logvar = 0 (D = 1)")
    t.close(f(torch.tensor([[0.0]]), torch.tensor([[float(np.log(4.0))]])), torch.tensor([0.8068528]), tol=1e-5, what="KL với mu = 0, logvar = ln 4 (D = 1)")
    t.close(f(torch.tensor([[1.0, 0.0]]), torch.tensor([[0.0, float(np.log(4.0))]])), torch.tensor([1.3068528]), tol=1e-5, what="KL của hai chiều latent (1, 0) và (0, ln 4): cộng lại")
    mu, logvar = _mv((5, 6), 7)
    t.close(f(mu, logvar), ref["kl_gaussian"](mu, logvar), tol=1e-5, what="KL trên dữ liệu ngẫu nhiên")


def test_kl_zero_nonneg(user, ref):
    """KL của (mu = 0, logvar = 0) đúng bằng 0 và KL ≥ 0 với mọi đầu vào; lệch khỏi (0, 0) thì dương"""
    f = need(user, "kl_gaussian")
    t.close(f(torch.zeros(3, 4), torch.zeros(3, 4)), torch.zeros(3), tol=1e-6, what="KL khi q trùng prior (mu = 0, logvar = 0)")
    mu, logvar = _mv((300, 5), 8)
    kl = f(mu * 2, logvar * 2)
    assert bool((kl >= -1e-6).all()), "KL ra số âm: KL giữa hai phân phối không bao giờ âm. Kiểm dấu từng hạng (1, logvar, mu², exp(logvar)) và hệ số."
    assert bool((f(mu, torch.zeros_like(mu)) > 0).all()) and bool((f(torch.zeros_like(mu), logvar) > 0).all()), "Chỉ mu khác 0 (hoặc chỉ logvar khác 0) mà KL vẫn không dương: q khác prior thì KL phải dương."


def test_kl_axis(user, ref):
    """KL cộng theo trục latent (trục cuối), bỏ trục đó: (B, D) → (B,), (B, T, D) → (B, T); cộng được theo từng nhóm chiều"""
    f = need(user, "kl_gaussian")
    for shape in [(4, 5), (2, 3, 5), (5,)]:
        mu, logvar = _mv(shape, 9)
        got = f(mu, logvar)
        t.shape(got, shape[:-1], what=f"KL với mu shape {shape}")
        t.close(got, ref["kl_gaussian"](mu, logvar), tol=1e-5, what=f"KL với mu shape {shape}")
    mu, logvar = _mv((4, 6), 10)
    t.close(f(mu, logvar), f(mu[:, :2], logvar[:, :2]) + f(mu[:, 2:], logvar[:, 2:]), tol=1e-5, what="KL của 6 chiều latent so với KL của 2 chiều đầu cộng KL của 4 chiều sau")


def test_kl_grad(user, ref):
    """Gradient của KL khớp lời giải chuẩn (∂/∂mu = mu, ∂/∂logvar = ½(e^logvar − 1)) và bằng 0 tại điểm cực tiểu (0, 0)"""
    f = need(user, "kl_gaussian")
    mu, logvar = _mv((4, 5), 11)
    t.grad_close(f, ref["kl_gaussian"], mu, logvar, tol=1e-5, what="gradient của KL")
    m, l = mu.clone().requires_grad_(True), logvar.clone().requires_grad_(True)
    f(m, l).sum().backward()
    t.close(m.grad, mu, tol=1e-5, what="∂KL/∂mu")
    t.close(l.grad, 0.5 * (torch.exp(logvar) - 1), tol=1e-5, what="∂KL/∂logvar")
    z0, z1 = torch.zeros(3, 4, requires_grad=True), torch.zeros(3, 4, requires_grad=True)
    f(z0, z1).sum().backward()
    assert float(z0.grad.abs().max()) < 1e-6 and float(z1.grad.abs().max()) < 1e-6, "Tại (mu = 0, logvar = 0) KL đạt cực tiểu nên gradient phải bằng 0."
