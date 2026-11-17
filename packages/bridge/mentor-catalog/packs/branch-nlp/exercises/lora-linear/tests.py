IN, OUT, R, ALPHA = 6, 4, 4, 12.0


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _fresh(user, in_f=IN, out_f=OUT, r=R, alpha=ALPHA, bias=True, seed=0):
    t.seed(seed)
    base = nn.Linear(in_f, out_f, bias=bias)
    try:
        return need(user, "LoRALinear")(base, r, alpha)
    except AttributeError as e:
        if bias:
            raise
        raise AssertionError(f"base không có bias (bias=False) mà code của bạn vẫn dùng base.bias: {e}")


def _pair(user, ref, in_f=IN, out_f=OUT, r=R, alpha=ALPHA, bias=True, seed=0):
    """Hai LoRALinear (của bạn, chuẩn) có cùng base, cùng A và cùng B khác 0 (khi mới khởi tạo B = 0 nên phải đổi nó)."""
    m = _fresh(user, in_f, out_f, r, alpha, bias, seed)
    t.seed(seed + 1)
    q = ref["LoRALinear"](nn.Linear(in_f, out_f, bias=bias), r, alpha)
    with torch.no_grad():
        q.B.copy_(torch.randn(q.B.shape, generator=_g(seed + 2)) * 0.5)
    t.load_into(m, q)
    return m, q


def _trainable(m):
    return sorted(n for n, p in m.named_parameters() if p.requires_grad)


def test_structure(user, ref):
    """Có đủ base, A, B, scale: A (r, in) và B (out, r) là nn.Parameter, scale = alpha / r, tên tham số khớp đề"""
    m = _fresh(user)
    assert isinstance(getattr(m, "base", None), nn.Linear), "LoRALinear cần thuộc tính base là nn.Linear (chính module được truyền vào)."
    for name, shape in [("A", (R, IN)), ("B", (OUT, R))]:
        p = getattr(m, name, None)
        assert isinstance(p, nn.Parameter), f"{name} phải là nn.Parameter (để optimizer và state_dict thấy được), không phải tensor thường."
        assert tuple(p.shape) == shape, f"{name} có shape {tuple(p.shape)}, cần {shape} (A là (r, in), B là (out, r))."
    scale = getattr(m, "scale", None)
    assert isinstance(scale, (int, float)) and not isinstance(scale, bool), "scale phải là một số Python (không phải tham số hay tensor)."
    assert abs(scale - ALPHA / R) < 1e-9, f"scale = {scale}, cần alpha / r = {ALPHA / R}."
    want = sorted(ref["LoRALinear"](nn.Linear(IN, OUT), R, ALPHA).state_dict())
    assert sorted(m.state_dict()) == want, f"Tên tham số trong state_dict là {sorted(m.state_dict())}, cần {want}."


def test_init(user, ref):
    """Khởi tạo: B toàn số 0, A ngẫu nhiên nhỏ (độ lệch chuẩn cỡ 1/√in), mỗi seed một khác"""
    in_f, out_f, r = 100, 50, 8
    m = _fresh(user, in_f, out_f, r, 16.0, seed=3)
    B, A = t.array(m.B), t.array(m.A)
    assert A.shape == (r, in_f) and B.shape == (out_f, r), f"A có shape {A.shape}, B có shape {B.shape}, cần ({r}, {in_f}) và ({out_f}, {r})."
    assert np.all(B == 0), "B phải khởi tạo toàn số 0 để adapter chưa làm đổi mô hình lúc xuất phát."
    std = float(A.std())
    assert std > 0, "A toàn số 0: nếu A cũng bằng 0 thì gradient của B bằng bao nhiêu, và adapter có bao giờ học được không?"
    assert 0.15 / in_f ** 0.5 < std < 3.0 / in_f ** 0.5, f"Độ lệch chuẩn của A là {std:.4f}, cần cỡ 1/√in = {in_f ** -0.5:.3f} (khoảng {0.15 / in_f ** 0.5:.3f} tới {3.0 / in_f ** 0.5:.3f})."
    other = _fresh(user, in_f, out_f, r, 16.0, seed=4)
    assert not np.allclose(A, t.array(other.A)), "Hai seed khác nhau mà cho cùng A: A phải khởi tạo ngẫu nhiên."


def test_identity_at_init(user, ref):
    """Ngay sau khi khởi tạo, LoRALinear cho đúng đầu ra của base (x 1, 2, 3 và 4 chiều)"""
    m = _fresh(user, seed=5)
    g = _g(6)
    for shape in [(IN,), (5, IN), (2, 3, IN), (2, 2, 3, IN)]:
        x = torch.randn(shape, generator=g)
        got = m(x)
        t.shape(got, shape[:-1] + (OUT,), what=f"đầu ra với x shape {shape}")
        t.close(got, m.base(x), tol=1e-6, what=f"đầu ra lúc mới khởi tạo với x shape {shape} (phải bằng base(x))")


def test_forward(user, ref):
    """Với A, B khác 0: đầu ra khớp lời giải chuẩn (x 2, 3 và 4 chiều); không bias thì vẫn đúng"""
    for bias in [True, False]:
        m, q = _pair(user, ref, bias=bias, seed=7)
        g = _g(8)
        for shape in [(5, IN), (2, 3, IN), (2, 2, 3, IN)]:
            x = torch.randn(shape, generator=g)
            got = m(x)
            t.shape(got, shape[:-1] + (OUT,), what=f"đầu ra với x shape {shape}")
            t.close(got, q(x), tol=1e-4, what=f"đầu ra với x shape {shape}, bias = {bias} (A là (r, in), B là (out, r): nhân theo hướng nào?)")
        assert float((m(x) - m.base(x)).abs().max()) > 1e-3, "Với B khác 0 mà đầu ra vẫn y hệt base(x): nhánh A, B đã được cộng vào chưa?"


def test_scale(user, ref):
    """Hệ số α/r: đổi r hoặc α thì phần cộng thêm đổi đúng theo α/r (không phải α, không phải 1)"""
    for r, alpha in [(2, 8.0), (8, 4.0), (4, 4.0)]:
        m, q = _pair(user, ref, r=r, alpha=alpha, seed=9 + r)
        assert abs(getattr(m, "scale", None) - alpha / r) < 1e-9, f"r = {r}, α = {alpha}: scale phải bằng α/r = {alpha / r}."
        x = torch.randn(4, IN, generator=_g(10 + r))
        t.close(m(x) - m.base(x), q(x) - q.base(x), tol=1e-4, what=f"phần LoRA thêm vào với r = {r}, α = {alpha}")


def test_freeze_and_count(user, ref):
    """Chỉ A và B cần gradient (base.weight và base.bias đóng băng); số tham số học được là r·(in + out)"""
    m = _fresh(user, 64, 48, 8, 16.0, seed=11)
    assert _trainable(m) == ["A", "B"], f"Tham số cần gradient là {_trainable(m)}, cần đúng ['A', 'B']: base đã đóng băng hết chưa (cả bias)?"
    n = sum(p.numel() for p in m.parameters() if p.requires_grad)
    assert n == 8 * (64 + 48), f"Số tham số học được là {n}, cần r·(in + out) = {8 * (64 + 48)}."
    nb = _fresh(user, 64, 48, 8, 16.0, bias=False, seed=12)
    assert nb.base.bias is None, "base không có bias thì LoRALinear không được tự thêm bias vào base."
    assert _trainable(nb) == ["A", "B"], f"Với base không có bias, tham số cần gradient là {_trainable(nb)}, cần đúng ['A', 'B']."


def test_gradients(user, ref):
    """Gradient: lúc mới khởi tạo B nhận gradient khác 0 còn A nhận 0; với A, B khác 0 thì khớp lời giải chuẩn; base không nhận gradient"""
    m = _fresh(user, seed=13)
    x = torch.randn(6, IN, generator=_g(14))
    w = torch.randn(6, OUT, generator=_g(15))
    (m(x) * w).sum().backward()
    assert m.A.grad is not None and m.B.grad is not None, "A hoặc B không nhận gradient: chúng có nằm trên đường từ x tới đầu ra, và có requires_grad không?"
    assert float(m.B.grad.abs().max()) > 1e-4, "Lúc mới khởi tạo B không nhận gradient (toàn 0): B học được từ đâu nếu A không đóng góp gì?"
    assert float(m.A.grad.abs().max()) == 0.0, "Lúc mới khởi tạo (B = 0) A đã nhận gradient khác 0: gradient của A phải đi qua B."
    m, q = _pair(user, ref, seed=16)
    (m(x) * w).sum().backward()
    (q(x) * w).sum().backward()
    t.close(m.A.grad, q.A.grad, tol=1e-4, what="gradient của A")
    t.close(m.B.grad, q.B.grad, tol=1e-4, what="gradient của B")
    assert m.base.weight.grad is None and (m.base.bias is None or m.base.bias.grad is None), "Trọng số của base đã đóng băng mà vẫn nhận gradient."


def test_base_untouched(user, ref):
    """Sau vài bước optimizer: base.weight và base.bias y nguyên, còn B đã đổi (adapter học được)"""
    m, _ = _pair(user, ref, seed=17)
    w0, b0 = m.base.weight.detach().clone(), m.base.bias.detach().clone()
    B0 = m.B.detach().clone()
    params = [p for p in m.parameters() if p.requires_grad]
    assert params, "Không có tham số nào cần gradient để đưa cho optimizer."
    opt = torch.optim.SGD(params, lr=0.01)
    x = torch.randn(7, IN, generator=_g(18))
    for _ in range(3):
        opt.zero_grad()
        (m(x) ** 2).mean().backward()
        opt.step()
    assert torch.equal(m.base.weight.detach(), w0), "base.weight đã bị optimizer sửa: nó chưa được đóng băng."
    assert torch.equal(m.base.bias.detach(), b0), "base.bias đã bị optimizer sửa: bias cũng phải đóng băng."
    assert not torch.equal(m.B.detach(), B0), "B không đổi sau 3 bước optimizer: adapter không học."
