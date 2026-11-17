def _g(seed):
    return torch.Generator().manual_seed(seed)


def _grad(f, values):
    lg = torch.tensor(values, requires_grad=True)
    out = f(lg)
    assert out.requires_grad, "Loss trả về không có gradient (requires_grad = False): có chỗ nào cắt đường gradient (detach, đổi sang số Python) không?"
    out.backward()
    return lg.grad


def test_values(user, ref):
    """g_loss_saturating ra một số ≤ 0: logits 0 cho −ln 2, logit +2 cho −2.1269, logit −2 cho −0.1269; khớp lời giải chuẩn"""
    f = need(user, "g_loss_saturating")
    got = f(torch.zeros(5))
    t.shape(got, (), what="g_loss_saturating (một số, không phải vector)")
    t.close(got, torch.tensor(-float(np.log(2.0))), tol=1e-5, what="loss khi mọi logits = 0 (log(1 − 0.5))")
    t.close(f(torch.tensor([2.0])), torch.tensor(-2.1269280), tol=1e-5, what="loss khi logit = +2 (D tin ảnh giả là thật: log(1 − D) rất âm)")
    t.close(f(torch.tensor([-2.0])), torch.tensor(-0.1269280), tol=1e-5, what="loss khi logit = -2 (D biết ảnh là giả: log(1 − D) gần 0)")
    z = torch.randn(7, generator=_g(1)) * 3
    t.close(f(z), ref["g_loss_saturating"](z), tol=1e-5, what="loss trên dữ liệu ngẫu nhiên")
    t.close(f(z.view(7, 1)), ref["g_loss_saturating"](z.view(7, 1)), tol=1e-5, what="loss với logits shape (7, 1)")


def test_direction(user, ref):
    """Chiều đúng: D bị lừa càng nhiều (logit càng lớn) thì loss của G càng thấp, gradient theo logit âm ở mọi nơi"""
    f = need(user, "g_loss_saturating")
    assert float(f(torch.full((4,), 3.0))) < float(f(torch.full((4,), -3.0))), "Loss khi D bị lừa (logit +3) phải THẤP hơn loss khi D biết chắc ảnh là giả (logit -3): G đang giảm loss, G thắng thì loss phải giảm."
    g = _grad(f, [-6.0, -1.0, 0.0, 1.0, 6.0])
    assert bool((g < 0).all()), "Gradient theo logit phải âm ở mọi nơi (tăng logit làm loss của G giảm). Dấu của loss đang đúng chưa?"


def test_saturation(user, ref):
    """Độ lớn gradient: bằng −σ(ℓ)/B, tức ≈ 0 khi D rất chắc ảnh là giả (ℓ = −20), −½/B ở ℓ = 0 và ≈ −1/B khi D bị lừa (ℓ = +20)"""
    f = need(user, "g_loss_saturating")
    g = _grad(f, [-20.0, 0.0, 20.0])
    assert abs(float(g[0])) < 1e-6, f"Gradient ở logit -20 là {float(g[0]):.3g}: với loss bão hòa nó phải gần 0 (D rất chắc ảnh là giả thì G gần như không nhận tín hiệu). Bạn có đang dùng dạng non-saturating không?"
    t.close(g, torch.tensor([0.0, -0.5 / 3, -1.0 / 3]), tol=1e-5, what="gradient theo logit tại (-20, 0, 20) với B = 3")


def test_extreme_logits(user, ref):
    """Logits ±200: loss đúng −100 và gradient (−0.5, 0), hữu hạn; sigmoid rồi log(1 − ·), thêm ε hoặc clamp đều sai ở đây"""
    f = need(user, "g_loss_saturating")
    lg = torch.tensor([200.0, -200.0], requires_grad=True)
    out = f(lg)
    assert torch.isfinite(out), "Loss ra -inf hoặc nan với logits ±200: sigmoid(200) = 1 trong float32 nên 1 − sigmoid = 0 và log(0) = -inf. Hãy viết log(1 − σ(ℓ)) theo dạng không bao giờ lấy log của số bằng 0."
    t.close(out, torch.tensor(-100.0), tol=1e-3, what="loss với logits (200, -200) (ảnh thứ nhất: −200, ảnh thứ hai: ≈ 0; nếu ra cỡ −9 thì bạn đã cắt giá trị bằng ε hoặc clamp)")
    out.backward()
    assert torch.isfinite(lg.grad).all(), "Gradient ra nan hoặc inf với logits ±200."
    t.close(lg.grad, torch.tensor([-0.5, 0.0]), tol=1e-4, what="gradient theo logit với logits (200, -200) (clamp hoặc cộng ε làm gradient mất ở ℓ = +200)")


def test_mean_over_elements(user, ref):
    """Trung bình trên mọi phần tử: lặp đôi logits không đổi loss, (B,) và (B, 1) cho cùng một số, không phải tổng"""
    f = need(user, "g_loss_saturating")
    z = torch.randn(6, generator=_g(2)) * 2
    t.close(f(torch.cat([z, z])), f(z), tol=1e-5, what="loss khi lặp đôi logits (phải giữ nguyên: trung bình, không cộng)")
    t.close(f(z.view(6, 1)), f(z), tol=1e-6, what="loss với logits (6, 1) so với (6,)")
    t.close(f(torch.zeros(10)), torch.tensor(-float(np.log(2.0))), tol=1e-5, what="loss với 10 logit 0 (mỗi phần tử −ln 2, trung bình vẫn −ln 2)")


def test_vs_nonsat(user, ref):
    """So với g_loss_nonsat của bài trước: gradient bão hòa = e^ℓ × gradient non-saturating (tỉ lệ D/(1 − D)); hai loss đổi vai nhau ở hai đầu"""
    sat, non = need(user, "g_loss_saturating"), need(user, "g_loss_nonsat")
    vals = [-6.0, -3.0, 0.0, 3.0, 6.0]
    gs, gn = _grad(sat, vals), _grad(non, vals)
    t.close(gs, gn * torch.exp(torch.tensor(vals)), tol=3e-5, what="gradient bão hòa so với e^ℓ × gradient non-saturating")
    assert abs(float(gs[0])) < 5e-3 * abs(float(gn[0])), "Ở logit -6 gradient bão hòa phải nhỏ hơn gradient non-saturating hàng trăm lần."
    assert abs(float(gn[-1])) < 5e-3 * abs(float(gs[-1])), "Ở logit +6 vai trò đảo ngược: gradient non-saturating mới là cái gần 0."


def test_flows_to_generator(user, ref):
    """Không detach: gradient chảy qua D về tham số của một generator tí hon, khớp lời giải chuẩn"""
    def run(fn):
        t.seed(30)
        gen, disc = nn.Linear(3, 4), nn.Linear(4, 1)
        z = torch.randn(6, 3, generator=_g(31))
        loss = fn(disc(gen(z)).squeeze(-1))
        assert loss.requires_grad, "Loss không có gradient: đường từ loss về logits của D rồi về G đã bị cắt (detach?)."
        loss.backward()
        return gen.weight.grad
    got = run(need(user, "g_loss_saturating"))
    assert got is not None and float(got.abs().max()) > 0, "Tham số của generator không nhận gradient."
    t.close(got, run(ref["g_loss_saturating"]), tol=1e-5, what="gradient của generator qua g_loss_saturating")
