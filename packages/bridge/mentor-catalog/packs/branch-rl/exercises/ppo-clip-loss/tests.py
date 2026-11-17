def _logps(ratios, seed=0):
    """old_logp ngẫu nhiên và new_logp = old_logp + log(ratio): tỉ số xác suất đúng bằng ratios đã chọn."""
    g = torch.Generator().manual_seed(seed)
    old = -2.0 + 0.5 * torch.randn(len(ratios), generator=g)
    new = old + torch.log(torch.as_tensor(ratios, dtype=torch.float32))
    return new, old


def _run(f, new, old, adv, eps):
    x = new.clone().detach().requires_grad_(True)
    loss = f(x, old, adv, eps)
    loss.backward()
    return loss.detach(), x.grad


def test_hand_example(user, ref):
    """Ví dụ tính tay bốn mẫu (eps = 0.2): tỉ số 1.5 và 0.5, advantage +2 và -2"""
    f = need(user, "ppo_clip_loss")
    new, old = _logps([1.5, 0.5, 1.5, 0.5])
    adv = torch.tensor([2.0, 2.0, -2.0, -2.0])
    got = float(f(new, old, adv, 0.2))
    assert abs(got - 0.3) < 1e-5, (
        f"Bốn mẫu (r, A) = (1.5, +2), (0.5, +2), (1.5, -2), (0.5, -2), eps = 0.2. Mỗi mẫu lấy số bi quan hơn giữa r*A và clip(r)*A: "
        f"[min(3, 2.4), min(1, 1.6), min(-3, -2.4), min(-1, -1.6)] = [2.4, 1.0, -3.0, -1.6], trung bình -0.3, loss = +0.3. Bạn ra {got:.4f}."
    )


def test_gradient_positive_advantage(user, ref):
    """A dương: tỉ số vượt 1 + eps bị cắt (gradient 0), tỉ số dưới 1 - eps vẫn có gradient (loss muốn kéo nó lên)"""
    f = need(user, "ppo_clip_loss")
    ratios = [1.5, 0.5, 1.1, 1.3, 0.7]
    new, old = _logps(ratios, 1)
    adv = torch.full((5,), 2.0)
    _, grad = _run(f, new, old, adv, 0.2)
    assert grad is not None, "new_logp không nhận được gradient."
    want = -(torch.tensor(ratios) * adv) / 5
    want[0] = 0.0
    want[3] = 0.0
    t.close(grad, want, tol=1e-5, what="gradient theo new_logp khi mọi A = +2 (r = [1.5, 0.5, 1.1, 1.3, 0.7], eps = 0.2)")
    assert float(grad[0]) == 0.0 and float(grad[3]) == 0.0, "A > 0 và r > 1 + eps: số hạng bị cắt được chọn, gradient phải bằng 0."


def test_gradient_negative_advantage(user, ref):
    """A âm: tỉ số dưới 1 - eps bị cắt (gradient 0), nhưng tỉ số vượt 1 + eps KHÔNG bị cắt (loss vẫn muốn kéo nó xuống)"""
    f = need(user, "ppo_clip_loss")
    ratios = [1.5, 0.5, 1.1, 0.9, 1.3]
    new, old = _logps(ratios, 2)
    adv = torch.full((5,), -2.0)
    _, grad = _run(f, new, old, adv, 0.2)
    assert grad is not None, "new_logp không nhận được gradient."
    want = -(torch.tensor(ratios) * adv) / 5
    want[1] = 0.0
    t.close(grad, want, tol=1e-5, what="gradient theo new_logp khi mọi A = -2 (r = [1.5, 0.5, 1.1, 0.9, 1.3], eps = 0.2)")
    assert float(grad[1]) == 0.0, "A < 0 và r < 1 - eps: số hạng bị cắt được chọn, gradient phải bằng 0."
    assert float(grad[0]) > 0 and float(grad[4]) > 0, (
        "A < 0 và r > 1 + eps (policy đã làm hành động xấu này nhiều hơn hẳn): phải vẫn có gradient dương để kéo xác suất xuống. "
        "Min giữa hai số hạng âm chọn số nào?"
    )


def test_ratio_from_log_probs(user, ref):
    """Tỉ số tính từ hiệu hai log-xác suất: khi xác suất nhỏ hơn mức float32 biểu diễn được, kết quả vẫn hữu hạn và đúng"""
    f = need(user, "ppo_clip_loss")
    new = torch.tensor([-120.0, -120.0])
    old = torch.tensor([-121.0, -121.0])
    adv = torch.tensor([1.0, -1.0])
    got = f(new, old, adv, 0.2)
    assert torch.isfinite(got).all(), (
        f"Kết quả là {float(got)}: log-xác suất -120 thì xác suất cỡ 1e-52, float32 làm tròn xuống 0 rồi chia 0/0. "
        f"Tỉ số của hai xác suất bằng gì khi biết hiệu hai log của chúng?"
    )
    want = -(1.2 - float(np.e)) / 2
    assert abs(float(got) - want) < 1e-4, f"r = e (hiệu log bằng 1), eps = 0.2: A = +1 cho min(e, 1.2) = 1.2; A = -1 cho min(-e, -1.2) = -e; loss = {want:.4f}. Bạn ra {float(got):.4f}."


def test_raw_advantages_and_unit_ratio(user, ref):
    """Policy chưa đổi (tỉ số 1): loss = -trung bình advantage thô, gradient = -A/B; hàm không chuẩn hóa advantage"""
    f = need(user, "ppo_clip_loss")
    old = torch.tensor([-1.0, -2.0, -0.5, -3.0])
    adv = torch.tensor([1.0, 2.0, 3.0, 4.0])
    loss, grad = _run(f, old.clone(), old, adv, 0.2)
    assert abs(float(loss) - (-2.5)) < 1e-5, (
        f"new_logp = old_logp thì r = 1 và loss = -mean(A) = -2.5 với A = [1, 2, 3, 4]; bạn ra {float(loss):.4f}. "
        f"Hàm này không được chuẩn hóa advantage (nơi gọi làm việc đó)."
    )
    t.close(grad, -adv / 4, tol=1e-5, what="gradient khi tỉ số bằng 1 (phải là -A/B)")


def test_advantages_and_old_logp_get_no_gradient(user, ref):
    """advantages và old_logp chỉ là hằng số: kể cả khi chúng đang gắn đồ thị, gradient không được chảy vào chúng"""
    f = need(user, "ppo_clip_loss")
    new, old = _logps([1.5, 0.5, 1.1, 0.9, 1.3, 0.7], 3)
    adv0 = torch.tensor([2.0, -1.0, 0.5, -0.5, 1.5, -2.0])
    adv = adv0.clone().requires_grad_(True)
    o = old.clone().requires_grad_(True)
    x = new.clone().requires_grad_(True)
    f(x, o, adv, 0.2).backward()
    assert adv.grad is None or float(adv.grad.abs().max()) == 0.0, "advantages nhận được gradient: advantage là hằng số trong loss của policy (nó không phụ thuộc theta)."
    assert o.grad is None or float(o.grad.abs().max()) == 0.0, "old_logp nhận được gradient: nó đến từ policy cũ, một hằng số."
    want = _run(ref["ppo_clip_loss"], new, old, adv0, 0.2)[1]
    t.close(x.grad, want, tol=1e-5, what="gradient theo new_logp")


def test_matches_reference(user, ref):
    """Nhiều batch, nhiều eps (kể cả eps rất lớn nên không có gì bị cắt), tỉ số rải rộng: khớp lời giải chuẩn cả giá trị lẫn gradient"""
    f = need(user, "ppo_clip_loss")
    for seed, B, eps in [(0, 8, 0.2), (1, 1, 0.1), (2, 32, 0.3), (3, 16, 0.5), (4, 20, 0.05), (5, 10, 10.0)]:
        g = torch.Generator().manual_seed(seed)
        old = -1.5 + torch.randn(B, generator=g)
        new = old + 0.5 * torch.randn(B, generator=g)
        adv = 2.0 * torch.randn(B, generator=g)
        got, g_got = _run(f, new, old, adv, eps)
        want, g_want = _run(ref["ppo_clip_loss"], new, old, adv, eps)
        t.shape(got, (), what="loss")
        t.close(got, want, tol=1e-5, what=f"loss (B={B}, eps={eps})")
        t.close(g_got, g_want, tol=1e-5, what=f"gradient (B={B}, eps={eps})")


def test_dtype_and_no_side_effects(user, ref):
    """loss là tensor float32 vô hướng còn gắn gradient của new_logp; không sửa các tensor vào"""
    f = need(user, "ppo_clip_loss")
    new, old = _logps([1.5, 0.5, 1.1, 0.9], 4)
    adv = torch.tensor([1.0, -1.0, 2.0, -2.0])
    x = new.clone().requires_grad_(True)
    saved = [x.detach().clone(), old.clone(), adv.clone()]
    loss = f(x, old, adv, 0.2)
    assert isinstance(loss, torch.Tensor) and loss.dim() == 0, "ppo_clip_loss phải trả về một tensor vô hướng (shape ())."
    assert loss.dtype == torch.float32, f"loss có dtype {loss.dtype}, cần float32."
    assert loss.requires_grad, "loss không còn gắn với new_logp: bạn có detach new_logp không?"
    for name, before, after in zip(["new_logp", "old_logp", "advantages"], saved, [x.detach(), old, adv]):
        assert torch.equal(before, after), f"{name} bị sửa tại chỗ."
