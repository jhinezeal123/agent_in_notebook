def _nets(seed=0, d=4, n_actions=3):
    t.seed(seed)
    q_net = nn.Linear(d, n_actions)
    t.seed(seed + 100)
    target_net = nn.Linear(d, n_actions)
    return q_net, target_net


def _batch(seed=0, size=8, d=4, n_actions=3, scale=3.0):
    g = torch.Generator().manual_seed(seed)
    states = torch.randn(size, d, generator=g)
    actions = torch.randint(0, n_actions, (size,), generator=g)
    rewards = scale * torch.randn(size, generator=g)
    next_states = torch.randn(size, d, generator=g)
    dones = torch.zeros(size)
    dones[::3] = 1.0
    return states, actions, rewards, next_states, dones


def _scaled_identity(factor, n=3):
    net = nn.Linear(n, n)
    with torch.no_grad():
        net.weight.copy_(factor * torch.eye(n))
        net.bias.zero_()
    return net


def _hand():
    """Q(s) = s với q_net, Q'(s') = 2 s' với target_net; batch ba phần tử, hành động chọn là 0, 1, 2."""
    states = torch.tensor([[1.0, 5.0, 2.0], [3.0, 2.0, 0.0], [0.0, 1.0, 4.0]])
    actions = torch.tensor([0, 1, 2])
    rewards = torch.tensor([0.5, 1.0, -2.0])
    next_states = torch.tensor([[1.0, 1.0, 0.0], [2.0, 0.0, 3.0], [0.0, 2.0, 1.0]])
    dones = torch.tensor([0.0, 1.0, 0.0])
    return _scaled_identity(1.0), _scaled_identity(2.0), (states, actions, rewards, next_states, dones)


def test_hand_example(user, ref):
    """Ví dụ tính tay với hai mạng tuyến tính đơn giản: loss = trung bình Huber của (Q đã chọn - target)"""
    f = need(user, "dqn_loss")
    q_net, target_net, batch = _hand()
    loss = f(q_net, target_net, batch, 0.9)
    got = float(loss)
    assert abs(got - 3.2 / 3) < 1e-5, (
        f"q_net(s) = s, target_net(s') = 2 s', gamma = 0.9. Q đã chọn = [1, 2, 4]; target = [2.3, 1.0 (done), 1.6]; "
        f"sai số = [-1.3, 1.0, 2.4]; Huber trung bình = 1.0667. Bạn ra {got:.4f}. Kiểm tra từng thành phần: Q của hành động đã chọn, target, loss."
    )


def test_gather_chosen_action(user, ref):
    """Q hiện tại lấy ở đúng hành động đã chọn (không phải hành động tốt nhất), và có shape (B,) trước khi so với target"""
    f = need(user, "dqn_loss")
    q_net = _scaled_identity(1.0)
    states = torch.tensor([[1.0, 5.0, 2.0], [3.0, 2.0, 0.0]])
    actions = torch.tensor([0, 1])
    rewards = torch.tensor([1.0, 2.0])
    dones = torch.ones(2)
    loss = f(q_net, _scaled_identity(2.0), (states, actions, rewards, states.clone(), dones), 0.9)
    assert abs(float(loss)) < 1e-6, f"Thưởng của mỗi phần tử đúng bằng Q của hành động đã chọn ([1, 2]) và done = 1, nên loss phải bằng 0; bạn ra {float(loss):.5f}. Bạn đang lấy Q của hành động nào, và theo trục nào?"
    actions2 = torch.tensor([1, 0])
    loss = f(q_net, _scaled_identity(2.0), (states, actions2, rewards, states.clone(), dones), 0.9)
    want = (torch.nn.functional.smooth_l1_loss(torch.tensor([5.0, 3.0]), rewards)).item()
    assert abs(float(loss) - want) < 1e-5, f"Đổi hành động chọn thành [1, 0]: Q đã chọn = [5, 3], loss phải là {want:.4f}; bạn ra {float(loss):.4f}."


def test_done_mask(user, ref):
    """Khi done = 1, target chỉ là thưởng: target_net và next_states không được ảnh hưởng"""
    f = need(user, "dqn_loss")
    q_net, tg1 = _nets(1)
    _, tg2 = _nets(2)
    states, actions, rewards, next_states, _ = _batch(1)
    dones = torch.ones(8)
    a = f(q_net, tg1, (states, actions, rewards, next_states, dones), 0.9)
    b = f(q_net, tg2, (states, actions, rewards, torch.randn(8, 4), dones), 0.9)
    q_sa = q_net(states).gather(1, actions.unsqueeze(1)).squeeze(1)
    want = F.smooth_l1_loss(q_sa, rewards)
    t.close(a, want, tol=1e-5, what="loss khi mọi phần tử đều done")
    t.close(b, want, tol=1e-5, what="loss khi done và đổi target_net, next_states")
    dones0 = torch.zeros(8)
    c = f(q_net, tg1, (states, actions, rewards, next_states, dones0), 0.9)
    d = f(q_net, tg2, (states, actions, rewards, next_states, dones0), 0.9)
    assert abs(float(c) - float(d)) > 1e-4, "Khi không done, target_net khác nhau phải cho loss khác nhau: target có dùng target_net không?"


def test_matches_reference(user, ref):
    """Nhiều batch, kích thước và gamma khác nhau (kể cả batch 1, gamma = 0): khớp lời giải chuẩn"""
    f = need(user, "dqn_loss")
    for seed, size, d, n_actions, gamma in [(0, 8, 4, 3, 0.99), (1, 1, 4, 3, 0.9), (2, 5, 6, 2, 0.5), (3, 16, 3, 4, 0.0), (4, 7, 5, 5, 0.97)]:
        q_net, target_net = _nets(seed, d, n_actions)
        batch = _batch(seed, size, d, n_actions)
        got = f(q_net, target_net, batch, gamma)
        want = ref["dqn_loss"](q_net, target_net, batch, gamma)
        t.shape(got, (), what=f"loss (batch {size})")
        t.close(got, want, tol=1e-5, what=f"loss (batch {size}, {n_actions} hành động, gamma {gamma})")


def test_gradients_only_to_q_net(user, ref):
    """Gradient chảy về q_net đúng như lời giải chuẩn, và target_net không nhận gradient nào"""
    f = need(user, "dqn_loss")
    for seed in range(3):
        qu, tu = _nets(seed)
        qr, tr = _nets(seed)
        f(qu, tu, _batch(seed), 0.95).backward()
        ref["dqn_loss"](qr, tr, _batch(seed), 0.95).backward()
        for name, pu, pr in zip(["weight", "bias"], qu.parameters(), qr.parameters()):
            assert pu.grad is not None, f"q_net.{name} không nhận được gradient: q_net(states) có bị detach không?"
            t.close(pu.grad, pr.grad, tol=1e-5, what=f"gradient của q_net.{name}")
        for name, p in zip(["weight", "bias"], tu.parameters()):
            assert p.grad is None or float(p.grad.abs().max()) == 0.0, f"target_net.{name} nhận được gradient: target phải được tính không qua đồ thị tính gradient (no_grad hoặc detach)."


def test_huber_not_mse(user, ref):
    """Loss là Huber (smooth L1), không phải MSE: sai số lớn chỉ tính tuyến tính, sai số nhỏ tính bình phương"""
    f = need(user, "dqn_loss")
    q_net = _scaled_identity(1.0)
    states = torch.tensor([[10.0, 0.0, 0.0], [0.4, 0.0, 0.0]])
    actions = torch.tensor([0, 0])
    rewards = torch.zeros(2)
    dones = torch.ones(2)
    loss = f(q_net, _scaled_identity(2.0), (states, actions, rewards, states.clone(), dones), 0.9)
    got = float(loss)
    assert abs(got - 4.79) < 1e-5, f"Sai số 10 và 0.4: Huber = (9.5 + 0.08) / 2 = 4.79 (MSE sẽ ra 50.08); bạn ra {got:.4f}. Loss gì và lấy trung bình hay tổng?"


def test_no_side_effects_and_dtype(user, ref):
    """loss là tensor float32 vô hướng còn gradient, không đổi batch và trọng số của hai mạng"""
    f = need(user, "dqn_loss")
    q_net, target_net = _nets(5)
    batch = _batch(5)
    saved = [x.clone() for x in batch]
    w_q = [p.detach().clone() for p in q_net.parameters()]
    w_t = [p.detach().clone() for p in target_net.parameters()]
    loss = f(q_net, target_net, batch, 0.99)
    assert isinstance(loss, torch.Tensor) and loss.dim() == 0, "dqn_loss phải trả về một tensor vô hướng (shape ())."
    assert loss.dtype == torch.float32, f"loss có dtype {loss.dtype}, cần float32."
    assert loss.requires_grad, "loss không còn gắn với đồ thị tính gradient của q_net: bạn có detach q_net(states) không?"
    for before, after in zip(saved, batch):
        assert torch.equal(before, after), "Batch bị sửa tại chỗ."
    for a, b in zip(w_q + w_t, list(q_net.parameters()) + list(target_net.parameters())):
        assert torch.equal(a, b.detach()), "Trọng số của mạng bị đổi khi tính loss (đừng gọi optimizer hay sửa tham số trong hàm này)."
