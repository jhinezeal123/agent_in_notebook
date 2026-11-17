KEYS = ["betas", "alphas", "alpha_bar", "sqrt_alpha_bar", "sqrt_one_minus_alpha_bar"]


def _make(user, *args):
    s = need(user, "make_schedule")(*args)
    assert isinstance(s, dict), f"make_schedule phải trả về một dict (có các khoá {KEYS}), nhưng trả về {type(s).__name__}."
    missing = [k for k in KEYS if k not in s]
    assert not missing, f"Dict trả về thiếu khoá {missing}: cần đủ {KEYS}."
    for k in KEYS:
        assert torch.is_tensor(s[k]), f's["{k}"] phải là một tensor PyTorch, nhưng là {type(s[k]).__name__}.'
    return s


def _truth(T, b0=1e-4, b1=0.02):
    b = np.linspace(b0, b1, T, dtype=np.float64)
    a = 1.0 - b
    return b, a, np.cumprod(a)


def test_betas_linear(user, ref):
    """betas tăng đều từ beta_start đến beta_end, gồm cả hai đầu mút (T = 1000, và T = 5 với 0.1 đến 0.5)"""
    s = _make(user, 1000)
    t.shape(s["betas"], (1000,), what="betas khi T = 1000")
    b, _, _ = _truth(1000)
    t.close(s["betas"][0], torch.tensor(1e-4), tol=1e-7, what="betas[0] (phải bằng beta_start)")
    t.close(s["betas"][-1], torch.tensor(0.02), tol=1e-7, what="betas[T-1] (phải bằng beta_end: đầu mút cuối cũng là một bước của lịch)")
    t.close(s["betas"], torch.tensor(b), tol=1e-6, what="betas khi T = 1000 (tăng đều)")
    s5 = _make(user, 5, 0.1, 0.5)
    t.close(s5["betas"], torch.tensor([0.1, 0.2, 0.3, 0.4, 0.5]), tol=1e-6, what="betas khi T = 5, từ 0.1 đến 0.5 (cách đều, gồm cả hai đầu)")


def test_alphas_and_alpha_bar(user, ref):
    """alphas = 1 − betas; alpha_bar là tích luỹ của alphas: alpha_bar[0] = alphas[0], giảm đơn điệu, alpha_bar[T-1] ≈ 4.04e-5 khi T = 1000"""
    s = _make(user, 1000)
    _, a, ab = _truth(1000)
    t.close(s["alphas"], torch.tensor(a), tol=1e-6, what="alphas (một trừ betas)")
    t.close(s["alpha_bar"][0], s["alphas"][0], tol=1e-7, what="alpha_bar[0] (mới đi qua đúng một bước nên phải bằng alphas[0])")
    t.close(s["alpha_bar"], torch.tensor(ab), tol=1e-5, what="alpha_bar khi T = 1000")
    t.close(s["alpha_bar"][-1], torch.tensor(float(ab[-1])), tol=1e-7, what="alpha_bar[T-1] (sau cả 1000 bước gần như không còn tín hiệu, cỡ 4e-5)")
    assert bool((s["alpha_bar"][1:] < s["alpha_bar"][:-1]).all()), "alpha_bar phải giảm nghiêm ngặt theo t: mỗi bước nhân thêm một số nhỏ hơn 1."
    s5 = _make(user, 5, 0.1, 0.5)
    t.close(s5["alpha_bar"], torch.tensor([0.9, 0.72, 0.504, 0.3024, 0.1512]), tol=1e-6, what="alpha_bar khi T = 5, betas 0.1 đến 0.5 (tích luỹ 0.9, 0.9·0.8, 0.9·0.8·0.7, …)")


def test_sqrt_terms(user, ref):
    """sqrt_alpha_bar = √ᾱ và sqrt_one_minus_alpha_bar = √(1 − ᾱ), và bình phương của hai số này cộng lại bằng 1 ở mọi bước"""
    s = _make(user, 1000)
    _, _, ab = _truth(1000)
    t.close(s["sqrt_alpha_bar"], torch.tensor(np.sqrt(ab)), tol=1e-5, what="sqrt_alpha_bar")
    t.close(s["sqrt_one_minus_alpha_bar"], torch.tensor(np.sqrt(1.0 - ab)), tol=2e-5, what="sqrt_one_minus_alpha_bar (căn của MỘT TRỪ alpha_bar, không phải một trừ căn)")
    total = s["sqrt_alpha_bar"] ** 2 + s["sqrt_one_minus_alpha_bar"] ** 2
    t.close(total, torch.ones(1000), tol=1e-5, what="(sqrt_alpha_bar)² + (sqrt_one_minus_alpha_bar)² (phải bằng 1 ở mọi bước)")


def test_small_T(user, ref):
    """Ca biên T = 1 (một bước) và T = 2 (chỉ hai đầu mút): đúng shape và giá trị"""
    s1 = _make(user, 1)
    for k in KEYS:
        t.shape(s1[k], (1,), what=f'"{k}" khi T = 1')
    t.close(s1["betas"], torch.tensor([1e-4]), tol=1e-7, what="betas khi T = 1 (chỉ có beta_start)")
    t.close(s1["alpha_bar"], torch.tensor([0.9999]), tol=1e-6, what="alpha_bar khi T = 1")
    s2 = _make(user, 2)
    t.close(s2["betas"], torch.tensor([1e-4, 0.02]), tol=1e-7, what="betas khi T = 2 (đúng hai đầu mút)")
    t.close(s2["alpha_bar"], torch.tensor([0.9999, 0.9999 * 0.98]), tol=1e-6, what="alpha_bar khi T = 2")


def test_float32(user, ref):
    """Cả năm tensor có kiểu float32 (kiểu mặc định của PyTorch) và shape (T,)"""
    s = _make(user, 10)
    for k in KEYS:
        assert s[k].dtype == torch.float32, f's["{k}"] có kiểu {s[k].dtype}, cần torch.float32 (các bài sau trộn nó với ảnh float32; NumPy mặc định ra float64).'
        t.shape(s[k], (10,), what=f'"{k}" khi T = 10')
