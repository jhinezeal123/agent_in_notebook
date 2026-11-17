def _g(seed):
    return torch.Generator().manual_seed(seed)


def _z(n, d, seed, scale=1.0):
    return torch.randn((n, d), generator=_g(seed)) * scale


def _loop(z1, z2, tau):
    """NT-Xent bằng vòng lặp numpy float64, theo đúng định nghĩa trong đề (độc lập với mọi bản cài đặt)."""
    a = np.concatenate([t.array(z1), t.array(z2)], axis=0)
    a = a / np.linalg.norm(a, axis=1, keepdims=True)
    n = len(a) // 2
    s = a @ a.T / tau
    total = 0.0
    for i in range(2 * n):
        pos = (i + n) % (2 * n)
        den = sum(np.exp(s[i, k]) for k in range(2 * n) if k != i)
        total += -np.log(np.exp(s[i, pos]) / den)
    return total / (2 * n)


def test_shape_and_inputs(user, ref):
    """Trả về một số (tensor 0 chiều, hữu hạn) với N = 1, 2, 5; không sửa z1, z2"""
    f = need(user, "nt_xent")
    for n in [1, 2, 5]:
        z1, z2 = _z(n, 8, n), _z(n, 8, 10 + n)
        k1, k2 = z1.clone(), z2.clone()
        loss = f(z1, z2, 0.5)
        t.shape(loss, (), what=f"loss với N = {n} (phải là một số, tensor 0 chiều)")
        assert bool(torch.isfinite(loss)), f"loss với N = {n} là nan hoặc inf."
        assert torch.equal(z1, k1) and torch.equal(z2, k2), "nt_xent đã sửa z1 hoặc z2 tại chỗ."


def test_values_loop(user, ref):
    """Giá trị khớp định nghĩa tính bằng vòng lặp trên embedding ngẫu nhiên (N = 6) với temperature 1.0, 0.5 và 0.2"""
    f = need(user, "nt_xent")
    for tau in [1.0, 0.5, 0.2]:
        z1, z2 = _z(6, 8, 20), _z(6, 8, 21)
        z2 = z2 + 0.8 * z1  # hai view cùng một ảnh có giống nhau phần nào
        t.close(f(z1, z2, tau), _loop(z1, z2, tau), tol=1e-4, what=f"loss với N = 6, temperature = {tau}")


def test_normalization(user, ref):
    """Chuẩn hóa L2: nhân từng vector với một số dương bất kỳ (độ dài rất khác nhau) không làm đổi loss"""
    f = need(user, "nt_xent")
    z1, z2 = _z(5, 8, 30), _z(5, 8, 31)
    z2 = z2 + z1
    a = torch.rand(5, 1, generator=_g(32)) * 20 + 0.1
    b = torch.rand(5, 1, generator=_g(33)) * 0.05 + 0.001
    base = f(z1, z2, 0.5)
    t.close(f(z1 * a, z2 * b, 0.5), base, tol=1e-4, what="loss sau khi nhân mỗi vector với một số dương khác nhau (độ giống phải là cosine, không phụ thuộc độ dài)")
    t.close(base, _loop(z1, z2, 0.5), tol=1e-4, what="loss với z1, z2 chưa chuẩn hóa")


def test_temperature_division(user, ref):
    """Temperature là số CHIA cosine: các cặp view trùng nhau và trực giao với mọi ảnh khác cho loss = log(1 + (2N − 2)·e^(−1/τ))"""
    f = need(user, "nt_xent")
    for n, tau in [(4, 0.5), (4, 0.2), (3, 0.3)]:
        e = torch.eye(8)[:n]
        want = float(np.log(1 + (2 * n - 2) * np.exp(-1.0 / tau)))
        t.close(f(e, e.clone(), tau), want, tol=1e-5, what=f"loss với N = {n}, τ = {tau} khi hai view y hệt nhau và các ảnh trực giao (positive có độ giống 1/τ, mọi negative có độ giống 0)")


def test_diagonal_masked(user, ref):
    """Loại chính nó khỏi mẫu số: khi mọi embedding giống hệt nhau thì loss = log(2N − 1), không phụ thuộc τ; N = 1 thì loss = 0"""
    f = need(user, "nt_xent")
    v = _z(1, 8, 40)
    for n in [3, 5]:
        same = v.expand(n, 8).clone()
        for tau in [1.0, 0.2]:
            t.close(f(same, same.clone(), tau), float(np.log(2 * n - 1)), tol=1e-4, what=f"loss với N = {n}, τ = {tau} khi mọi embedding giống hệt nhau (mẫu số có 2N − 1 số hạng bằng nhau)")
    t.close(f(_z(1, 8, 41), _z(1, 8, 42), 0.5), 0.0, tol=1e-6, what="loss với N = 1 (mỗi hàng chỉ còn positive để so với chính nó)")


def test_symmetric_mean(user, ref):
    """Đối xứng và trung bình trên 2N vector: hoán đổi z1 với z2 không đổi loss, và nó là trung bình của loss neo ở z1 với loss neo ở z2"""
    f = need(user, "nt_xent")
    z1, z2 = _z(6, 8, 50), _z(6, 8, 51)
    z2 = z2 + z1
    t.close(f(z1, z2, 0.3), f(z2, z1, 0.3), tol=1e-5, what="loss khi hoán đổi z1 và z2 (mỗi view đều làm neo cho view kia)")
    a = t.array(z1)
    a = a / np.linalg.norm(a, axis=1, keepdims=True)
    b = t.array(z2)
    b = b / np.linalg.norm(b, axis=1, keepdims=True)
    full = np.concatenate([a, b])
    s = full @ full.T / 0.3
    lse = np.log(np.exp(s - np.diag(np.full(12, np.inf))).sum(axis=1))
    per = lse - s[np.arange(12), (np.arange(12) + 6) % 12]
    t.close(f(z1, z2, 0.3), per.mean(), tol=1e-4, what="loss so với trung bình của 12 loss riêng lẻ (chia cho 2N = 12, không phải N = 6, không phải tổng)")


def test_stability(user, ref):
    """Ổn định số: temperature rất nhỏ (0.01, 0.02) và embedding rất dài (hàng nghìn) vẫn cho loss hữu hạn, đúng giá trị"""
    f = need(user, "nt_xent")
    for tau in [0.02, 0.01]:
        z1, z2 = _z(6, 8, 60, scale=2000.0), _z(6, 8, 61, scale=2000.0)
        z2 = z2 + 3.0 * z1
        got = f(z1, z2, tau)
        assert bool(torch.isfinite(got)), f"loss là nan hoặc inf với τ = {tau}: s/τ lên tới {1 / tau:.0f}, exp của nó tràn float32. Dùng phép nào tính log-softmax mà không tự tính exp?"
        t.close(got, _loop(z1, z2, tau), tol=1e-3, what=f"loss với τ = {tau} và embedding dài")


def test_gradients(user, ref):
    """Gradient: cả z1 và z2 đều nhận gradient khớp lời giải chuẩn, hữu hạn kể cả khi τ nhỏ"""
    f, g = need(user, "nt_xent"), ref["nt_xent"]
    z1, z2 = _z(5, 8, 70), _z(5, 8, 71)
    t.grad_close(lambda a, b: f(a, b, 0.3), lambda a, b: g(a, b, 0.3), z1, z2, tol=1e-4, what="gradient của loss")
    a, b = z1.clone().requires_grad_(True), z2.clone().requires_grad_(True)
    f(a, b, 0.05).backward()
    for name, x in [("z1", a), ("z2", b)]:
        assert x.grad is not None, f"{name} không nhận gradient (bị detach?)."
        assert bool(torch.isfinite(x.grad).all()), f"gradient theo {name} có nan hoặc inf với τ = 0.05 (loại chính nó khỏi mẫu số có làm hỏng gradient không?)."
