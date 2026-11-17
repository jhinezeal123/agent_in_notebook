def _g(seed):
    return torch.Generator().manual_seed(seed)


def _z(n, d, seed):
    return torch.randn((n, d), generator=_g(seed))


def _pair(user, ref, init_tau=0.07, log_scale=None):
    """Hai module (của bạn, chuẩn) cùng log_scale; log_scale có thể được đặt tay."""
    m = need(user, "LearnableTemperature")(init_tau)
    q = ref["LearnableTemperature"](init_tau)
    if log_scale is not None:
        with torch.no_grad():
            q.log_scale.fill_(log_scale)
    t.load_into(m, q)
    return m, q


def test_structure(user, ref):
    """log_scale là nn.Parameter 0 chiều bằng ln(1 / init_tau) (mặc định init_tau = 0.07), và là tham số duy nhất"""
    cls = need(user, "LearnableTemperature")
    m = cls()
    params = dict(m.named_parameters())
    assert sorted(params) == ["log_scale"], f"Tham số của module là {sorted(params)}, cần đúng ['log_scale'] (máy chấm chép trọng số theo tên)."
    p = params["log_scale"]
    assert isinstance(p, nn.Parameter) and p.dim() == 0, f"log_scale phải là nn.Parameter 0 chiều (một số), hiện có shape {tuple(p.shape)}."
    assert not list(m.buffers()), "Module không cần buffer nào."
    t.close(p, float(np.log(1.0 / 0.07)), tol=1e-5, what="log_scale khi khởi tạo mặc định (ln(1 / 0.07))")
    for tau in [0.5, 1.0, 0.2]:
        t.close(cls(tau).log_scale, float(np.log(1.0 / tau)), tol=1e-5, what=f"log_scale khi init_tau = {tau} (logarit của nghịch đảo của τ, không phải của τ)")


def test_forward_matches(user, ref):
    """forward khớp lời giải chuẩn và khớp nt_xent của bạn ở τ = 1 / exp(log_scale), với init_tau 0.07, 0.5, 1.0 và một log_scale đặt tay"""
    base = need(user, "nt_xent")
    z1, z2 = _z(6, 8, 1), _z(6, 8, 2)
    z2 = z2 + z1
    for tau in [0.07, 0.5, 1.0]:
        m, q = _pair(user, ref, tau)
        got = m(z1, z2)
        t.shape(got, (), what="loss của LearnableTemperature (một số, tensor 0 chiều)")
        t.close(got, q(z1, z2), tol=1e-4, what=f"loss với init_tau = {tau}")
        t.close(got, base(z1, z2, tau), tol=1e-4, what=f"loss với init_tau = {tau} so với nt_xent(z1, z2, temperature = {tau}) của bạn (τ = 1 / exp(ln(1/τ)))")
    m, q = _pair(user, ref, 0.5, log_scale=float(np.log(3.0)))
    t.close(m(z1, z2), q(z1, z2), tol=1e-4, what="loss khi log_scale = ln 3 (τ = 1/3)")


def test_uses_nt_xent(user, ref):
    """Dùng lại nt_xent của bạn: đúng một lần gọi, với đúng z1, z2 và temperature = 1/s là tensor còn trong đồ thị gradient"""
    m, _ = _pair(user, ref, 0.2)
    z1, z2 = _z(4, 8, 3), _z(4, 8, 4)
    calls = []
    orig = user["nt_xent"]

    def spy(a, b, temperature=0.5):
        calls.append((a, b, temperature))
        return orig(a, b, temperature)

    user["nt_xent"] = spy
    try:
        m(z1, z2)
    finally:
        user["nt_xent"] = orig
    assert len(calls) == 1, f"forward gọi nt_xent của bạn {len(calls)} lần, cần đúng 1 lần (bài này bọc nt_xent, không viết lại loss)."
    a, b, tau = calls[0]
    assert a is z1 and b is z2, "forward phải đưa nguyên z1, z2 cho nt_xent."
    assert abs(float(tau) - 0.2) < 1e-5, f"temperature đưa cho nt_xent là {float(tau):.4f}, cần 1 / exp(log_scale) = 0.2."
    assert isinstance(tau, torch.Tensor) and tau.requires_grad, "temperature đưa cho nt_xent phải là tensor còn trong đồ thị gradient (log_scale phải ảnh hưởng tới nó), không phải số Python."


def test_identical_embeddings(user, ref):
    """Khi mọi embedding giống hệt nhau, loss = log(2N − 1) và temperature không còn ảnh hưởng: gradient theo log_scale bằng 0"""
    for n in [3, 5]:
        m, _ = _pair(user, ref, 0.07)
        v = _z(1, 8, 10)
        same = v.expand(n, 8).clone()
        loss = m(same, same.clone())
        t.close(loss, float(np.log(2 * n - 1)), tol=1e-4, what=f"loss với N = {n} khi mọi embedding giống hệt nhau")
        loss.backward()
        assert m.log_scale.grad is not None, "log_scale không nhận gradient (temperature có còn trong đồ thị tính toán không?)."
        assert abs(float(m.log_scale.grad)) < 1e-4, f"Gradient theo log_scale là {float(m.log_scale.grad):.4f}, cần 0: khi mọi logit bằng nhau, đổi temperature không đổi loss."


def test_orthogonal_gradient(user, ref):
    """Các view trùng nhau và trực giao với ảnh khác (τ = 0.5, N = 4): loss = log(1 + 6·e^(−s)) và d loss / d log_scale = −s·6e^(−s) / (1 + 6e^(−s)), s = 1/τ"""
    m, _ = _pair(user, ref, 0.5)
    e = torch.eye(8)[:4]
    s = 2.0
    loss = m(e, e.clone())
    t.close(loss, float(np.log(1 + 6 * np.exp(-s))), tol=1e-5, what="loss với view trùng nhau, các ảnh trực giao, τ = 0.5")
    loss.backward()
    assert m.log_scale.grad is not None, "log_scale không nhận gradient: temperature đưa cho nt_xent có bị chuyển thành số Python không (float, .item())?"
    want = -s * 6 * np.exp(-s) / (1 + 6 * np.exp(-s))
    t.close(m.log_scale.grad, want, tol=1e-4, what="gradient theo log_scale (loss giảm khi s tăng: temperature nhỏ đi giúp positive nổi hơn)")


def test_clamp(user, ref):
    """Chặn s ≤ 100 ngay trong forward: log_scale = ln 500 cho cùng loss như s = 100, gradient theo log_scale bằng 0 và giá trị log_scale không bị sửa"""
    big = float(np.log(500.0))
    m, q = _pair(user, ref, 0.07, log_scale=big)
    z1, z2 = _z(5, 8, 20), _z(5, 8, 21)
    z2 = z2 + 0.5 * z1  # hai view chỉ giống một phần: loss chưa bão hòa, nên τ = 0.01 và τ = 0.002 cho loss khác nhau
    loss = m(z1, z2)
    t.close(loss, q(z1, z2), tol=1e-3, what="loss khi log_scale = ln 500 (s phải bị chặn ở 100, tức τ = 0.01)")
    t.close(loss, need(user, "nt_xent")(z1, z2, 0.01), tol=1e-3, what="loss khi log_scale = ln 500 so với nt_xent(z1, z2, 0.01)")
    loss.backward()
    assert m.log_scale.grad is not None and abs(float(m.log_scale.grad)) < 1e-6, "Khi s bị chặn ở 100 thì loss không phụ thuộc log_scale, gradient phải bằng 0: bạn chặn bằng phép nào, và nó có cho gradient đi qua không?"
    assert abs(float(m.log_scale) - big) < 1e-6, "forward đã sửa giá trị của log_scale: chỉ được chặn s dùng trong phép tính, không sửa tham số."
    m, q = _pair(user, ref, 0.07, log_scale=float(np.log(60.0)))
    t.close(m(z1, z2), q(z1, z2), tol=1e-3, what="loss khi log_scale = ln 60 (dưới ngưỡng chặn: không được chặn)")


def test_gradient_matches(user, ref):
    """Gradient theo log_scale (embedding ngẫu nhiên, N = 6) khớp lời giải chuẩn ở init_tau 0.1 và 0.5"""
    for tau in [0.1, 0.5]:
        m, q = _pair(user, ref, tau)
        z1, z2 = _z(6, 8, 30), _z(6, 8, 31)
        z2 = z2 + 1.5 * z1
        m(z1, z2).backward()
        q(z1, z2).backward()
        assert m.log_scale.grad is not None, "log_scale không nhận gradient."
        t.close(m.log_scale.grad, q.log_scale.grad, tol=1e-4, what=f"gradient theo log_scale với init_tau = {tau}")
