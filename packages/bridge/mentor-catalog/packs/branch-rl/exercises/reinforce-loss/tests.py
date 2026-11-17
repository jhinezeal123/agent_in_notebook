def _data(seed=0, T=7, A=3, scale=1.0):
    g = torch.Generator().manual_seed(seed)
    logits = scale * torch.randn(T, A, generator=g)
    actions = torch.randint(0, A, (T,), generator=g)
    returns = 3.0 * torch.randn(T, generator=g)
    baseline = torch.randn(T, generator=g)
    return logits, actions, returns, baseline


def _run(f, logits, actions, returns, baseline=None, normalize=False):
    x = logits.clone().requires_grad_(True)
    loss = f(x, actions, returns, baseline=baseline, normalize=normalize)
    loss.backward()
    return loss.detach(), x.grad


def _analytic_grad(logits, actions, adv):
    """d loss / d logits = -(1/T) * adv_t * (onehot(a_t) - softmax(logits_t))"""
    pi = torch.softmax(logits.detach(), dim=-1)
    onehot = F.one_hot(actions, logits.shape[1]).to(logits.dtype)
    return -(adv.detach().unsqueeze(1) * (onehot - pi)) / logits.shape[0]


def test_hand_example(user, ref):
    """Ví dụ tính tay: logits bằng 0 nên xác suất đều, loss là trung bình của -log(1/2) nhân trọng số"""
    f = need(user, "reinforce_loss")
    logits = torch.zeros(2, 2)
    actions = torch.tensor([0, 1])
    returns = torch.tensor([2.0, 4.0])
    got = float(f(logits, actions, returns))
    assert abs(got - 3 * 0.6931472) < 1e-5, (
        f"logits = 0 nên pi = 1/2 ở mọi hành động, log pi = -ln 2 = -0.6931; returns = [2, 4], không baseline: "
        f"loss = -(1/2) * (-0.6931 * 2 - 0.6931 * 4) = 2.0794. Bạn ra {got:.4f}. Dấu và phép lấy trung bình ở đâu?"
    )
    got = float(f(logits, actions, returns, baseline=torch.tensor([1.0, 1.0])))
    assert abs(got - 2 * 0.6931472) < 1e-5, f"Cùng ví dụ, baseline = [1, 1]: A = [1, 3], loss = 0.6931 * mean(A) = 1.3863. Bạn ra {got:.4f}. Baseline được trừ đi hay cộng vào?"


def test_gradient_matches_analytic(user, ref):
    """Gradient theo logits đúng bằng công thức giải tích -(1/T) * A_t * (onehot(a_t) - softmax)"""
    f = need(user, "reinforce_loss")
    for seed, T, A in [(0, 7, 3), (1, 5, 5), (2, 11, 2)]:
        logits, actions, returns, baseline = _data(seed, T, A)
        for b in (None, baseline):
            adv = returns if b is None else returns - b
            loss, grad = _run(f, logits, actions, returns, b)
            assert grad is not None, "logits không nhận được gradient: log-xác suất có còn gắn với logits không?"
            t.close(grad, _analytic_grad(logits, actions, adv), tol=1e-5,
                    what=f"gradient theo logits (T={T}, A={A}, {'không' if b is None else 'có'} baseline)")


def test_sign_of_the_update(user, ref):
    """Dấu đúng: một bước giảm loss làm tăng xác suất hành động có A dương và giảm xác suất hành động có A âm"""
    f = need(user, "reinforce_loss")
    logits = torch.zeros(1, 3)
    actions = torch.tensor([1])
    _, g_pos = _run(f, logits, actions, torch.tensor([2.0]))
    _, g_neg = _run(f, logits, actions, torch.tensor([-2.0]))
    assert float(g_pos[0, 1]) < 0, (
        f"return = +2 cho hành động 1: để xác suất của nó tăng, gradient của loss theo logit 1 phải âm (đi ngược gradient thì logit tăng); bạn ra {float(g_pos[0, 1]):+.3f}. "
        f"Optimizer giảm loss: loss của bạn có cần dấu âm không?"
    )
    assert float(g_neg[0, 1]) > 0, f"return = -2: gradient theo logit của hành động đã chọn phải dương; bạn ra {float(g_neg[0, 1]):+.3f}."
    _, g_base = _run(f, logits, actions, torch.tensor([2.0]), baseline=torch.tensor([5.0]))
    assert float(g_base[0, 1]) > 0, (
        f"return = 2 nhưng baseline = 5 nên A = -3 < 0: hành động này tệ hơn mức bình thường, gradient theo logit 1 phải dương; bạn ra {float(g_base[0, 1]):+.3f}. Trừ hay cộng baseline?"
    )


def test_baseline_and_returns_get_no_gradient(user, ref):
    """baseline và returns chỉ là trọng số: gradient không được chảy vào chúng (kể cả khi chúng đang gắn đồ thị)"""
    f = need(user, "reinforce_loss")
    logits, actions, returns, baseline = _data(4)
    for normalize in (False, True):
        b = baseline.clone().requires_grad_(True)
        r = returns.clone().requires_grad_(True)
        x = logits.clone().requires_grad_(True)
        f(x, actions, r, baseline=b, normalize=normalize).backward()
        assert b.grad is None or float(b.grad.abs().max()) == 0.0, (
            "baseline nhận được gradient từ loss của policy: baseline thường là đầu ra của mạng giá trị (có huấn luyện riêng); "
            "trong loss này nó chỉ là một con số hằng."
        )
        assert r.grad is None or float(r.grad.abs().max()) == 0.0, "returns nhận được gradient: trọng số A_t phải được coi là hằng số."
        t.close(x.grad, _run(ref["reinforce_loss"], logits, actions, returns, baseline, normalize)[1], tol=1e-5, what=f"gradient theo logits (normalize={normalize})")


def test_large_logits_stable(user, ref):
    """Logits rất lớn (±1000): log-xác suất của hành động ít khả năng vẫn hữu hạn và đúng, gradient không NaN"""
    f = need(user, "reinforce_loss")
    logits = torch.tensor([[1000.0, 0.0, -1000.0], [-1000.0, 0.0, 1000.0]])
    actions = torch.tensor([2, 0])
    returns = torch.tensor([1.0, 1.0])
    loss, grad = _run(f, logits, actions, returns)
    assert torch.isfinite(loss).all(), (
        f"Với logits chênh nhau 2000, xác suất của hành động đã chọn nhỏ hơn mức float32 biểu diễn được (kết quả {float(loss)}). "
        f"Log-xác suất đúng là -2000, loss = 2000. Có cách tính log mà không đi qua xác suất không?"
    )
    t.close(loss, torch.tensor(2000.0), tol=1e-3, what="loss với logits lớn")
    assert torch.isfinite(grad).all(), "Gradient có NaN hoặc inf với logits lớn."
    t.close(grad, _analytic_grad(logits, actions, returns), tol=1e-5, what="gradient với logits lớn")


def test_normalize_advantage(user, ref):
    """normalize=True: A có trung bình 0, độ lệch chuẩn 1 (std mặc định của PyTorch, có eps); bất biến với thang và dịch của return; hằng số thì không ra NaN"""
    f = need(user, "reinforce_loss")
    logits, actions, returns, baseline = _data(5, T=9, A=4)
    for b in (None, baseline):
        adv = returns if b is None else returns - b
        norm = (adv - adv.mean()) / (adv.std() + 1e-8)
        loss, grad = _run(f, logits, actions, returns, b, normalize=True)
        t.close(grad, _analytic_grad(logits, actions, norm), tol=1e-5, what=f"gradient với normalize=True ({'không' if b is None else 'có'} baseline)")
    a = f(logits, actions, returns, normalize=True)
    b2 = f(logits, actions, 10.0 * returns + 5.0, normalize=True)
    t.close(b2, a, tol=1e-4, what="loss khi return nhân 10 và cộng 5 (chuẩn hóa phải khử thang và dịch)")
    const = torch.full((6,), 2.0)
    l6, ac6, _, _ = _data(6, T=6, A=3)
    got = f(l6, ac6, const, normalize=True)
    assert torch.isfinite(got).all(), "Mọi A bằng nhau (độ lệch chuẩn 0) làm loss thành NaN: mẫu số chuẩn hóa cần một số nhỏ cộng vào."
    assert abs(float(got)) < 1e-5, f"Mọi return bằng nhau: sau chuẩn hóa A = 0 nên loss = 0; bạn ra {float(got):.5f}."


def test_matches_reference(user, ref):
    """Nhiều shape (T khác A, T = 1, A = 2), có và không baseline, có và không chuẩn hóa: khớp lời giải chuẩn cả giá trị lẫn gradient"""
    f = need(user, "reinforce_loss")
    for seed, T, A in [(0, 7, 3), (1, 1, 4), (2, 5, 5), (3, 12, 2), (4, 9, 6)]:
        logits, actions, returns, baseline = _data(seed, T, A, scale=2.0)
        for b in (None, baseline):
            for norm in ((False, True) if T > 1 else (False,)):
                got, g_got = _run(f, logits, actions, returns, b, norm)
                want, g_want = _run(ref["reinforce_loss"], logits, actions, returns, b, norm)
                t.shape(got, (), what="loss")
                t.close(got, want, tol=1e-5, what=f"loss (T={T}, A={A}, baseline={'có' if b is not None else 'không'}, normalize={norm})")
                t.close(g_got, g_want, tol=1e-5, what=f"gradient (T={T}, A={A}, baseline={'có' if b is not None else 'không'}, normalize={norm})")


def test_end_to_end_with_returns_to_go(user, ref):
    """Nối đầu-cuối: thưởng thô -> returns_to_go (của bạn) -> loss, khớp lời giải chuẩn"""
    f = need(user, "reinforce_loss")
    rtg = need(user, "returns_to_go")
    rewards = np.array([1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 2.0])
    dones = np.array([0, 0, 1, 0, 1, 0, 0, 0, 1])
    g_user = torch.as_tensor(np.asarray(rtg(rewards, 0.9, dones)), dtype=torch.float32)
    g_ref = torch.as_tensor(np.asarray(ref["returns_to_go"](rewards, 0.9, dones)), dtype=torch.float32)
    assert g_user.shape == (9,), f"returns_to_go của bạn trả về shape {tuple(g_user.shape)}, cần (9,)."
    logits, actions, _, _ = _data(7, T=9, A=3)
    for norm in (False, True):
        got, g1 = _run(f, logits, actions, g_user, None, norm)
        want, g2 = _run(ref["reinforce_loss"], logits, actions, g_ref, None, norm)
        t.close(got, want, tol=1e-5, what=f"loss đầu-cuối (normalize={norm})")
        t.close(g1, g2, tol=1e-5, what=f"gradient đầu-cuối (normalize={norm})")


def test_dtype_and_no_side_effects(user, ref):
    """loss là tensor float32 vô hướng còn gắn gradient của logits; không sửa các tensor vào"""
    f = need(user, "reinforce_loss")
    logits, actions, returns, baseline = _data(8)
    x = logits.clone().requires_grad_(True)
    saved = [x.detach().clone(), actions.clone(), returns.clone(), baseline.clone()]
    loss = f(x, actions, returns, baseline=baseline, normalize=True)
    assert isinstance(loss, torch.Tensor) and loss.dim() == 0, "reinforce_loss phải trả về một tensor vô hướng (shape ())."
    assert loss.dtype == torch.float32, f"loss có dtype {loss.dtype}, cần float32."
    assert loss.requires_grad, "loss không còn gắn với logits: bạn có detach log-xác suất không?"
    for name, before, after in zip(["logits", "actions", "returns", "baseline"], saved, [x.detach(), actions, returns, baseline]):
        assert torch.equal(before, after), f"{name} bị sửa tại chỗ."
