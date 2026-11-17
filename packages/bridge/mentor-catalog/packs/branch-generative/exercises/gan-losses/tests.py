LN2 = float(np.log(2.0))


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _softplus(x):
    return np.log1p(np.exp(np.asarray(x, dtype=np.float64)))


def test_d_values(user, ref):
    """d_loss ra một số: logits 0 cho 2·ln 2, (thật 2, giả -2) cho 2·softplus(-2) ≈ 0.2539, và khớp lời giải chuẩn trên dữ liệu ngẫu nhiên"""
    f = need(user, "d_loss")
    z = torch.zeros(5)
    got = f(z, z)
    t.shape(got, (), what="d_loss (một số, không phải vector)")
    t.close(got, torch.tensor(2 * LN2), tol=1e-5, what="d_loss khi mọi logits = 0 (D đoán 0.5 cho mọi ảnh: mỗi hạng là ln 2)")
    t.close(f(torch.tensor([2.0]), torch.tensor([-2.0])), torch.tensor(0.2538560), tol=1e-5, what="d_loss với logit thật = 2 và logit giả = -2")
    real, fake = torch.randn(6, generator=_g(1)) * 2, torch.randn(6, generator=_g(2)) * 2
    t.close(f(real, fake), ref["d_loss"](real, fake), tol=1e-5, what="d_loss trên dữ liệu ngẫu nhiên")
    r2, f2 = real.view(3, 2), fake.view(3, 2)
    t.close(f(r2, f2), ref["d_loss"](r2, f2), tol=1e-5, what="d_loss với logits shape (3, 2)")


def test_d_labels(user, ref):
    """Nhãn đúng chiều: D phân biệt tốt (thật logit cao, giả logit thấp) cho loss gần 0; D bị lừa hoàn toàn cho loss lớn"""
    f = need(user, "d_loss")
    t.close(f(torch.full((4,), 5.0), torch.full((4,), -5.0)), torch.tensor(0.0134306), tol=1e-5, what="d_loss khi D phân biệt tốt (thật +5, giả -5)")
    t.close(f(torch.full((4,), -5.0), torch.full((4,), 5.0)), torch.tensor(10.0134306), tol=1e-4, what="d_loss khi D sai hoàn toàn (thật -5, giả +5): nhãn thật = 1, giả = 0")
    only_real = f(torch.full((4,), 3.0), torch.full((4,), 0.0))
    only_fake = f(torch.full((4,), 0.0), torch.full((4,), 3.0))
    assert float(only_fake) > float(only_real), "Tăng logit trên ảnh GIẢ phải làm loss của D tăng (D đang tin nhầm), còn tăng logit trên ảnh THẬT phải làm nó giảm: kiểm lại nhãn của từng nhóm."


def test_d_unequal_batches(user, ref):
    """Hai nhóm khác cỡ: mỗi hạng là trung bình của riêng nhóm đó (không trộn chung), lặp đôi cả hai nhóm không đổi loss"""
    f = need(user, "d_loss")
    real = torch.tensor([1.0, 2.0, 3.0, 4.0])
    fake = torch.tensor([0.5])
    want = _softplus(-real.numpy()).mean() + _softplus(fake.numpy()).mean()
    t.close(f(real, fake), torch.tensor(float(want)), tol=1e-5, what="d_loss với 4 ảnh thật và 1 ảnh giả (trung bình riêng từng nhóm, rồi cộng)")
    t.close(f(torch.cat([real, real]), torch.cat([fake, fake])), f(real, fake), tol=1e-5, what="d_loss khi lặp đôi mỗi nhóm (phải giữ nguyên: trung bình, không cộng)")
    r, fk = torch.randn(3, generator=_g(3)), torch.randn(8, generator=_g(4))
    t.close(f(r, fk), ref["d_loss"](r, fk), tol=1e-5, what="d_loss với 3 ảnh thật và 8 ảnh giả")


def test_g_values(user, ref):
    """g_loss_nonsat: logits 0 cho ln 2, logit +2 cho softplus(-2) ≈ 0.1269 (D bị lừa thì loss nhỏ), logit -2 cho ≈ 2.1269, khớp lời giải chuẩn"""
    f = need(user, "g_loss_nonsat")
    got = f(torch.zeros(5))
    t.shape(got, (), what="g_loss_nonsat (một số, không phải vector)")
    t.close(got, torch.tensor(LN2), tol=1e-5, what="g_loss_nonsat khi mọi logits = 0")
    t.close(f(torch.tensor([2.0])), torch.tensor(0.1269280), tol=1e-5, what="g_loss_nonsat khi D tin ảnh giả là thật (logit +2)")
    t.close(f(torch.tensor([-2.0])), torch.tensor(2.1269280), tol=1e-5, what="g_loss_nonsat khi D biết ảnh là giả (logit -2): G phải chịu loss lớn")
    z = torch.randn(7, generator=_g(5)) * 3
    t.close(f(z), ref["g_loss_nonsat"](z), tol=1e-5, what="g_loss_nonsat trên dữ liệu ngẫu nhiên")
    t.close(f(z.view(7, 1)), ref["g_loss_nonsat"](z.view(7, 1)), tol=1e-5, what="g_loss_nonsat với logits shape (7, 1)")


def test_g_gradient(user, ref):
    """Gradient của g_loss_nonsat theo logit luôn âm (tăng logit làm G thắng): bằng −σ(−ℓ)/B, và vẫn gần −1/B khi D rất tự tin ảnh là giả (ℓ = −10)"""
    f = need(user, "g_loss_nonsat")
    logits = torch.tensor([-10.0, -2.0, 0.0, 2.0, 6.0], requires_grad=True)
    out = f(logits)
    assert out.requires_grad, "g_loss_nonsat trả về tensor không có gradient (requires_grad = False): có hàm nào trong đó cắt đường gradient (detach, hay chuyển sang số Python) không?"
    out.backward()
    want = -torch.sigmoid(-logits.detach()) / 5
    assert bool((logits.grad < 0).all()), "Gradient theo logit phải âm ở mọi chỗ: tăng logit (D tin ảnh giả là thật) phải làm loss của G giảm. Dấu của loss đang đúng chưa?"
    t.close(logits.grad, want, tol=1e-6, what="gradient theo logit (−σ(−ℓ) chia cho số phần tử)")
    assert abs(float(logits.grad[0])) > 0.19, "Khi D rất tự tin ảnh là giả (logit -10), gradient theo logit phải còn lớn (gần 1/B): đó là điểm khác của loss non-saturating."


def test_g_flows_to_generator(user, ref):
    """g_loss_nonsat không detach: gradient chảy qua D về tham số của một generator tí hon, khớp lời giải chuẩn"""
    def run(fn):
        t.seed(20)
        gen, disc = nn.Linear(3, 4), nn.Linear(4, 1)
        z = torch.randn(6, 3, generator=_g(21))
        loss = fn(disc(gen(z)).squeeze(-1))
        assert loss.requires_grad, "g_loss_nonsat trả về một tensor không có gradient (requires_grad = False): đường từ loss về logits của D, rồi về G, đã bị cắt chỗ nào?"
        loss.backward()
        return gen.weight.grad
    got = run(need(user, "g_loss_nonsat"))
    assert got is not None and float(got.abs().max()) > 0, "Tham số của generator không nhận gradient."
    t.close(got, run(ref["g_loss_nonsat"]), tol=1e-5, what="gradient của generator qua g_loss_nonsat")


def test_extreme_logits(user, ref):
    """Logits ±200: loss và gradient của cả hai hàm vẫn hữu hạn và đúng (200 mỗi ảnh sai nặng); sigmoid rồi log sẽ ra inf hoặc nan"""
    fd, fg = need(user, "d_loss"), need(user, "g_loss_nonsat")
    real = torch.tensor([-200.0, 200.0], requires_grad=True)
    fake = torch.tensor([200.0, -200.0], requires_grad=True)
    got = fd(real, fake)
    assert torch.isfinite(got), "d_loss ra inf hoặc nan với logits ±200: sigmoid(200) = 1 chính xác trong float32, nên 1 − sigmoid = 0 và log(0) = -inf. Dùng hàm BCE nhận logits."
    t.close(got, torch.tensor(200.0), tol=1e-3, what="d_loss với thật = (-200, 200) và giả = (200, -200): mỗi nhóm có một ảnh D sai 200")
    got.backward()
    assert torch.isfinite(real.grad).all() and torch.isfinite(fake.grad).all(), "Gradient của d_loss ra nan hoặc inf với logits ±200."
    t.close(real.grad, torch.tensor([-0.5, 0.0]), tol=1e-4, what="gradient của d_loss theo logit thật")
    t.close(fake.grad, torch.tensor([0.5, 0.0]), tol=1e-4, what="gradient của d_loss theo logit giả")
    lg = torch.tensor([-200.0, 200.0], requires_grad=True)
    g = fg(lg)
    assert torch.isfinite(g), "g_loss_nonsat ra inf hoặc nan với logits ±200."
    t.close(g, torch.tensor(100.0), tol=1e-3, what="g_loss_nonsat với logits (-200, 200)")
    g.backward()
    t.close(lg.grad, torch.tensor([-0.5, 0.0]), tol=1e-4, what="gradient của g_loss_nonsat với logits (-200, 200)")


def test_d_gradients(user, ref):
    """Gradient của d_loss: ∂/∂logit thật = −σ(−ℓ)/Br, ∂/∂logit giả = σ(ℓ)/Bf; khớp lời giải chuẩn"""
    f = need(user, "d_loss")
    real, fake = torch.randn(4, generator=_g(6)) * 2, torch.randn(7, generator=_g(7)) * 2
    t.grad_close(f, ref["d_loss"], real, fake, tol=1e-5, what="gradient của d_loss")
    r, fk = real.clone().requires_grad_(True), fake.clone().requires_grad_(True)
    f(r, fk).backward()
    t.close(r.grad, -torch.sigmoid(-real) / 4, tol=1e-6, what="∂d_loss/∂logit thật (chia cho số ảnh thật)")
    t.close(fk.grad, torch.sigmoid(fake) / 7, tol=1e-6, what="∂d_loss/∂logit giả (chia cho số ảnh giả)")
