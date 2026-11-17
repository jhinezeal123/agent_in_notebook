IN, HID, LAT = 16, 8, 3


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _x(b, d, seed):
    g = _g(seed)
    x = (torch.rand(b, d, generator=g) > 0.5).float()
    x[0, :3] = torch.tensor([0.25, 0.5, 0.75])  # vài pixel xám: BCE vẫn hợp lệ với nhãn trong [0, 1]
    return x


def _vals(b, d, lat, seed):
    g = _g(seed)
    return _x(b, d, seed), torch.randn(b, d, generator=g) * 2, torch.randn(b, lat, generator=g), torch.randn(b, lat, generator=g) * 0.7


def _pair(user, ref, seed=0):
    t.seed(seed)
    m = need(user, "VAE")(IN, HID, LAT)
    t.seed(seed + 1)
    q = ref["VAE"](IN, HID, LAT)
    t.load_into(m, q)
    return m, q


def test_structure(user, ref):
    """VAE có đủ enc, fc_mu, fc_logvar, dec đúng shape và tên tham số khớp đề; gọi không tham số vẫn chạy (16, 32, 4)"""
    cls = need(user, "VAE")
    t.seed(0)
    m = cls(IN, HID, LAT)
    assert isinstance(m, nn.Module), "VAE phải kế thừa nn.Module."
    for name, shape in [("fc_mu", (LAT, HID)), ("fc_logvar", (LAT, HID))]:
        layer = getattr(m, name, None)
        assert isinstance(layer, nn.Linear), f"Thiếu {name} (nn.Linear(hidden, latent))."
        assert tuple(layer.weight.shape) == shape, f"{name}.weight có shape {tuple(layer.weight.shape)}, cần {shape}."
    assert isinstance(getattr(m, "enc", None), nn.Module) and isinstance(getattr(m, "dec", None), nn.Module), "Thiếu enc hoặc dec (nn.Sequential theo đề)."
    want = sorted(ref["VAE"](IN, HID, LAT).state_dict())
    assert sorted(m.state_dict()) == want, f"Tên tham số trong state_dict là {sorted(m.state_dict())}, cần {want}: giữ đúng cấu trúc enc/dec như đề (Sequential, ReLU giữa các Linear)."
    d = cls()
    assert tuple(d.enc[0].weight.shape) == (32, 16) and tuple(d.fc_mu.weight.shape) == (4, 32), "Giá trị mặc định phải là in_dim=16, hidden=32, latent=4."


def test_forward_shapes(user, ref):
    """forward trả ba tensor (x_logits, mu, logvar) với shape (B, in_dim), (B, latent), (B, latent); eps tùy chọn"""
    m, _ = _pair(user, ref)
    x = _x(5, IN, 1)
    out = m(x)
    assert isinstance(out, (tuple, list)) and len(out) == 3, "forward phải trả ba giá trị: (x_logits, mu, logvar)."
    t.shape(out[0], (5, IN), what="x_logits")
    t.shape(out[1], (5, LAT), what="mu")
    t.shape(out[2], (5, LAT), what="logvar")
    out1 = m(x[:1], torch.zeros(1, LAT))
    t.shape(out1[0], (1, IN), what="x_logits với batch 1")


def test_forward_values(user, ref):
    """Khi chép trọng số chuẩn và cho cùng eps: x_logits, mu, logvar khớp lời giải chuẩn (decoder trả logits, chưa sigmoid)"""
    m, q = _pair(user, ref, seed=2)
    x = _x(6, IN, 3)
    eps = torch.randn(6, LAT, generator=_g(4))
    lg, mu, lv = m(x, eps)
    want_lg, want_mu, want_lv = q(x, eps)
    t.close(mu, want_mu, tol=1e-5, what="mu (encoder: enc rồi fc_mu)")
    t.close(lv, want_lv, tol=1e-5, what="logvar (encoder: enc rồi fc_logvar)")
    t.close(lg, want_lg, tol=1e-5, what="x_logits với eps cho trước (decoder nhận z đã lấy mẫu; đầu ra là logits, không qua sigmoid, không bị cắt vào [0, 1])")


def test_noise_path(user, ref):
    """z đi qua reparameterize: eps = 0 thì decoder nhận đúng mu; eps khác nhau cho logits khác nhau, không truyền eps thì mỗi lần một noise mới"""
    m, q = _pair(user, ref, seed=5)
    x = _x(4, IN, 6)
    lg0, mu, lv = m(x, torch.zeros(4, LAT))
    t.close(lg0, m.dec(mu), tol=1e-5, what="x_logits khi eps = 0 (z = mu nên bằng dec(mu))")
    lg1, mu1, lv1 = m(x, torch.ones(4, LAT))
    t.close(mu1, mu, tol=1e-6, what="mu khi đổi eps (mu chỉ phụ thuộc x)")
    assert float((lg1 - lg0).abs().max()) > 1e-3, "Đổi eps mà x_logits không đổi: decoder có nhận z (mu + σ·eps) không, hay đang nhận mu?"
    t.seed(7)
    a = m(x)[0]
    b = m(x)[0]
    assert not torch.equal(a, b), "Hai lần gọi forward(x) không truyền eps cho cùng x_logits: noise phải lấy mới mỗi lần (reparameterize đã tự lấy khi eps=None)."


def test_loss_values(user, ref):
    """Loss tính tay: logits = 0, mu = 0, logvar = 0 cho đúng D·ln 2; thêm mu = 1 thì cộng ½·latent (KL trung bình theo batch); khớp lời giải chuẩn"""
    f = need(user, "elbo_loss")
    for d in [16, 32]:
        x = _x(4, d, 8)
        got = f(x, torch.zeros(4, d), torch.zeros(4, LAT), torch.zeros(4, LAT))
        t.shape(got, (), what="loss (một số, không phải vector)")
        t.close(got, torch.tensor(d * float(np.log(2.0))), tol=1e-4, what=f"loss với D = {d}, logits = 0, KL = 0 (tái tạo cộng theo pixel, trung bình theo batch: kỳ vọng D·ln 2)")
    x = _x(4, 16, 9)
    got = f(x, torch.zeros(4, 16), torch.ones(4, LAT), torch.zeros(4, LAT))
    t.close(got, torch.tensor(16 * float(np.log(2.0)) + 0.5 * LAT), tol=1e-4, what="loss khi mu = 1, logvar = 0 (mỗi ảnh có KL = ½·latent; lấy trung bình theo batch chứ không cộng)")
    x, lg, mu, lv = _vals(5, 16, LAT, 10)
    t.close(f(x, lg, mu, lv), ref["elbo_loss"](x, lg, mu, lv), tol=1e-4, what="loss trên dữ liệu ngẫu nhiên")


def test_loss_reduction(user, ref):
    """Quy ước gộp: lặp đôi batch không đổi loss (trung bình theo batch), nhân đôi số pixel thì tái tạo gấp đôi (cộng theo pixel, không trung bình)"""
    f = need(user, "elbo_loss")
    x, lg, mu, lv = _vals(4, 16, LAT, 11)
    one = f(x, lg, mu, lv)
    two = f(torch.cat([x, x]), torch.cat([lg, lg]), torch.cat([mu, mu]), torch.cat([lv, lv]))
    t.close(two, one, tol=1e-4, what="loss khi lặp đôi batch (nếu gấp đôi: bạn đang cộng theo batch thay vì lấy trung bình)")
    z = torch.zeros(4, LAT)
    short = f(x, lg, z, z)
    wide = f(torch.cat([x, x], dim=1), torch.cat([lg, lg], dim=1), z, z)
    t.close(wide, 2 * short, tol=1e-3, what="tái tạo khi nhân đôi số pixel (phải gấp đôi: một ảnh là TỔNG BCE của các pixel; nếu không đổi, bạn đang lấy trung bình theo pixel)")


def test_beta(user, ref):
    """Hệ số beta chỉ nhân với KL: beta = 0 chỉ còn tái tạo, beta = 2 và 0.5 khớp lời giải chuẩn, mặc định là 1"""
    f = need(user, "elbo_loss")
    x, lg, mu, lv = _vals(5, 16, LAT, 12)
    recon = ref["elbo_loss"](x, lg, mu, lv, beta=0.0)
    t.close(f(x, lg, mu, lv, beta=0.0), recon, tol=1e-4, what="loss khi beta = 0 (chỉ còn tái tạo, KL không đóng góp)")
    for beta in [0.5, 2.0]:
        t.close(f(x, lg, mu, lv, beta=beta), ref["elbo_loss"](x, lg, mu, lv, beta=beta), tol=1e-4, what=f"loss khi beta = {beta} (beta nhân KL, không nhân tái tạo)")
    t.close(f(x, lg, mu, lv), ref["elbo_loss"](x, lg, mu, lv, beta=1.0), tol=1e-4, what="loss khi không truyền beta (mặc định 1)")


def test_large_logits(user, ref):
    """Logits cực lớn (±200) vẫn cho loss hữu hạn và đúng (200 mỗi pixel đoán sai), gradient hữu hạn: BCE tính từ logits, không qua sigmoid rồi log"""
    f = need(user, "elbo_loss")
    x = torch.tensor([[1.0, 0.0, 1.0, 0.0], [0.0, 1.0, 1.0, 0.0]])
    lg = torch.tensor([[-200.0, 200.0, 200.0, -200.0], [200.0, -200.0, 200.0, -200.0]], requires_grad=True)
    z = torch.zeros(2, LAT)
    got = f(x, lg, z, z)
    assert torch.isfinite(got), "Loss ra nan hoặc inf với logits cực lớn: sigmoid rồi log mất độ chính xác khi sigmoid(logit) bằng đúng 0 hoặc 1."
    t.close(got, torch.tensor(400.0), tol=1e-2, what="loss với logits ±200 (mỗi ảnh đoán sai 2 pixel với logit lệch 200: kỳ vọng 400; nếu ra 200 thì BCE đã bị cắt ở -100)")
    got.backward()
    assert torch.isfinite(lg.grad).all(), "Gradient ra nan hoặc inf với logits cực lớn."
    t.close(lg.grad, (torch.sigmoid(lg.detach()) - x) / 2, tol=1e-4, what="gradient theo x_logits với logits cực lớn")


def test_loss_grads(user, ref):
    """Gradient theo x_logits, mu, logvar khớp lời giải chuẩn: ∂/∂logits = (sigmoid(logits) − x)/B, ∂/∂mu = mu/B"""
    f = need(user, "elbo_loss")
    x, lg, mu, lv = _vals(5, 16, LAT, 13)
    t.grad_close(lambda a, b, c: f(x, a, b, c, 2.0), lambda a, b, c: ref["elbo_loss"](x, a, b, c, 2.0), lg, mu, lv, tol=1e-4, what="gradient của loss")
    a, b, c = lg.clone().requires_grad_(True), mu.clone().requires_grad_(True), lv.clone().requires_grad_(True)
    f(x, a, b, c, 2.0).backward()
    t.close(a.grad, (torch.sigmoid(lg) - x) / 5, tol=1e-5, what="∂loss/∂x_logits (chia cho B vì trung bình theo batch)")
    t.close(b.grad, 2.0 * mu / 5, tol=1e-5, what="∂loss/∂mu với beta = 2 (beta·mu/B)")


def test_trains(user, ref):
    """Ghép model và loss: loss(x, *model(x, eps)) khớp lời giải chuẩn, mọi tham số nhận gradient và một bước SGD nhỏ làm loss giảm"""
    m, q = _pair(user, ref, seed=14)
    f = need(user, "elbo_loss")
    x = _x(8, IN, 15)
    eps = torch.randn(8, LAT, generator=_g(16))
    got = f(x, *m(x, eps))
    t.close(got, ref["elbo_loss"](x, *q(x, eps)), tol=1e-4, what="loss của cả mô hình (model → elbo_loss) với cùng trọng số và eps")
    got.backward()
    for name, p in m.named_parameters():
        assert p.grad is not None and torch.isfinite(p.grad).all(), f"Tham số {name} không nhận được gradient hợp lệ: đường từ loss về encoder và decoder có bị cắt không?"
    opt = torch.optim.SGD(m.parameters(), lr=1e-3)
    opt.step()
    after = f(x, *m(x, eps))
    assert float(after) < float(got), f"Một bước SGD nhỏ (lr = 1e-3) mà loss không giảm ({float(got):.4f} → {float(after):.4f}): dấu của loss hoặc đường gradient có vấn đề."
