def _greedy_net(n_actions):
    # Q(s) = các thành phần đầu của s: hành động tốt nhất là chỉ số của thành phần lớn nhất (ví dụ obs = [2, 0.5, -0.5, 0] thì chọn 0).
    net = nn.Linear(4, n_actions)
    with torch.no_grad():
        net.weight.zero_()
        net.bias.zero_()
        for a in range(n_actions):
            net.weight[a, a] = 1.0
    return net


OBS = np.array([2.0, 0.5, -0.5, 0.0], dtype=np.float32)


def _actions(select, net, obs, eps, n, seed):
    rng = np.random.default_rng(seed)
    return np.array([select(net, obs, eps, rng) for _ in range(n)])


def _filled_buffer(ref, n=40, d=4, seed=0):
    rng = np.random.default_rng(seed)
    buf = ref["ReplayBuffer"](100)
    for _ in range(n):
        buf.push(rng.normal(size=d).astype(np.float32), int(rng.integers(2)), float(rng.normal()), rng.normal(size=d).astype(np.float32), bool(rng.random() < 0.2))
    return buf


def _run_steps(step_fn, ref, n_steps, buffer_size=40):
    t.seed(3)
    q = ref["QNet"](4, 2, 16)
    t.seed(4)
    target = ref["QNet"](4, 2, 16)
    opt = torch.optim.SGD(q.parameters(), lr=0.05)
    buf = _filled_buffer(ref, n=buffer_size)
    rng = np.random.default_rng(5)
    losses = [step_fn(q, target, opt, buf, 16, 0.9, rng) for _ in range(n_steps)]
    return q, target, losses


def test_qnet_matches_reference(user, ref):
    """QNet có ba lớp fc1, fc2, out; ReLU sau hai lớp đầu và không có ReLU ở đầu ra: cùng Q-value với bản chuẩn khi chép trọng số"""
    QNet = need(user, "QNet")
    net = QNet(5, 3, 16)
    ref_net = ref["QNet"](5, 3, 16)
    with torch.no_grad():
        ref_net.out.bias.fill_(-1.0)
    t.load_into(net, ref_net)
    x = torch.randn(6, 5, generator=torch.Generator().manual_seed(1))
    t.shape(net(x), (6, 3), what="đầu ra của QNet với x shape (6, 5)")
    t.close(net(x), ref_net(x), tol=1e-5, what="Q-value của QNet (sau khi chép trọng số chuẩn; Q-value được phép âm)")


def test_qnet_default_sizes(user, ref):
    """QNet() không đối số là 4 → 64 → 64 → 2: nhận (B, 4), trả (B, 2), đúng 4 610 tham số"""
    net = need(user, "QNet")()
    n_params = sum(p.numel() for p in net.parameters())
    assert n_params == 4610, f"QNet() có {n_params} tham số, cần 4 610 (ba lớp Linear 4→64, 64→64, 64→2, có bias)."
    t.shape(net(torch.zeros(3, 4)), (3, 2), what="đầu ra của QNet() với x shape (3, 4)")


def test_epsilon_linear_schedule(user, ref):
    """ε bắt đầu ở eps_start, giảm tuyến tính (đúng nửa đường ở nửa số bước) và tới đúng eps_end ở bước decay_steps"""
    f = need(user, "epsilon_by_step")
    cases = [(0, (1.0, 0.1, 1000), 1.0), (500, (1.0, 0.1, 1000), 0.55), (1000, (1.0, 0.1, 1000), 0.1), (100, (0.9, 0.2, 400), 0.725), (300, (0.9, 0.2, 400), 0.375)]
    for step, args, want in cases:
        got = float(f(step, *args))
        assert abs(got - want) < 1e-6, f"epsilon_by_step({step}, {args[0]}, {args[1]}, {args[2]}) = {got:.4f}, cần {want:.4f}: ε đi từ eps_start (bước 0) xuống eps_end (bước decay_steps) theo đường thẳng."


def test_epsilon_floor(user, ref):
    """Sau decay_steps bước ε dừng ở eps_end: không tiếp tục giảm xuống dưới đáy, không tăng lại"""
    f = need(user, "epsilon_by_step")
    for step in [1001, 2000, 5000, 10 ** 6]:
        got = float(f(step, 1.0, 0.05, 1000))
        assert abs(got - 0.05) < 1e-6, f"epsilon_by_step({step}, 1.0, 0.05, 1000) = {got:.4f}, cần 0.05: sau decay_steps bước, ε phải giữ nguyên ở eps_end."


def test_select_greedy_when_eps_zero(user, ref):
    """ε = 0: luôn chọn hành động có Q lớn nhất (với hai và ba hành động, nhiều trạng thái khác nhau)"""
    select = need(user, "select_action")
    rng = np.random.default_rng(0)
    for n_actions in [2, 3]:
        net = _greedy_net(n_actions)
        for _ in range(25):
            obs = rng.normal(size=4).astype(np.float32)
            want = int(np.argmax(obs[:n_actions]))
            got = select(net, obs, 0.0, rng)
            assert int(got) == want, f"Với {n_actions} hành động, Q = {np.round(obs[:n_actions], 3).tolist()}: cần hành động {want}, bạn chọn {int(got)}. Khi ε = 0 không được khám phá."


def test_select_returns_python_int(user, ref):
    """select_action trả về một số nguyên Python (không phải tensor hay mảng), cả khi khám phá lẫn khi chọn tham lam"""
    select = need(user, "select_action")
    net = _greedy_net(2)
    rng = np.random.default_rng(0)
    for eps in [0.0, 1.0]:
        a = select(net, OBS, eps, rng)
        assert isinstance(a, (int, np.integer)) and not isinstance(a, bool), f"Với ε = {eps}, select_action trả về {type(a).__name__}, cần số nguyên (int): môi trường nhận hành động là số, không phải tensor."


def test_select_explore_rate(user, ref):
    """Xác suất chọn hành động tham lam đúng như ε quy định: với 2 hành động, ε = 0,2 thì khoảng 0,9; ε = 0,8 thì khoảng 0,6"""
    select = need(user, "select_action")
    net = _greedy_net(2)
    for eps, want in [(0.2, 0.9), (0.8, 0.6)]:
        acts = _actions(select, net, OBS, eps, 3000, seed=1)
        freq = float(np.mean(acts == 0))
        assert abs(freq - want) < 0.04, f"Với ε = {eps}, hành động tham lam được chọn {freq:.2f} số lần, cần khoảng {want:.2f}. Khi khám phá, hành động ngẫu nhiên được rút ra như thế nào, và ε là xác suất của việc gì?"


def test_select_explore_uniform(user, ref):
    """ε = 1: mọi hành động (kể cả hành động tham lam) được chọn đều nhau, khoảng 1/3 mỗi hành động với 3 hành động"""
    select = need(user, "select_action")
    net = _greedy_net(3)
    acts = _actions(select, net, OBS, 1.0, 3000, seed=2)
    freqs = [float(np.mean(acts == a)) for a in range(3)]
    assert all(abs(f - 1 / 3) < 0.05 for f in freqs), f"Với ε = 1 và 3 hành động, tần suất các hành động 0, 1, 2 là {[round(f, 2) for f in freqs]}, cần cùng khoảng 0,33: khám phá là chọn đều trong mọi hành động."


def test_select_uses_given_rng(user, ref):
    """Mọi lựa chọn ngẫu nhiên đi qua rng được truyền vào: hai rng cùng seed cho đúng cùng chuỗi hành động, dù random, numpy, torch ở ngoài bị đặt seed khác nhau"""
    select = need(user, "select_action")
    net = _greedy_net(3)
    runs = []
    for outside in [11, 22]:
        t.seed(outside)
        runs.append(_actions(select, net, OBS, 0.7, 150, seed=9))
    assert np.array_equal(runs[0], runs[1]), "Hai lần chạy với rng cùng seed cho chuỗi hành động khác nhau: select_action đang dùng một nguồn ngẫu nhiên khác ngoài rng được truyền vào (random, np.random, torch…)."


def test_sync_hard_copy(user, ref):
    """sync_target với tau mặc định chép đúng mọi tham số (weight và bias) của q_net sang target_net; q_net không bị đổi"""
    sync = need(user, "sync_target")
    t.seed(1)
    q = ref["QNet"](4, 2, 16)
    t.seed(2)
    target = ref["QNet"](4, 2, 16)
    q_before = [p.detach().clone() for p in q.parameters()]
    try:
        sync(q, target)
    except RuntimeError as e:
        raise AssertionError(f"sync_target báo lỗi khi sửa tham số của target_net ({str(e)[:90]}). Sửa tham số tại chỗ cần được đặt ngoài đồ thị tính gradient.")
    for (name, p), (_, pt) in zip(q.named_parameters(), target.named_parameters()):
        t.close(pt, p, tol=1e-6, what=f"tham số {name} của target_net sau khi sync")
    for (name, p), before in zip(q.named_parameters(), q_before):
        assert torch.equal(p.detach(), before), f"sync_target đã sửa tham số {name} của q_net: chỉ target_net được đổi."


def test_sync_is_a_copy(user, ref):
    """Sau sync_target, target_net là bản sao độc lập: sửa tại chỗ q_net về sau không làm target_net đổi theo"""
    sync = need(user, "sync_target")
    t.seed(1)
    q = ref["QNet"](4, 2, 16)
    t.seed(2)
    target = ref["QNet"](4, 2, 16)
    sync(q, target)
    snapshot = [p.detach().clone() for p in target.parameters()]
    with torch.no_grad():
        for p in q.parameters():
            p.add_(1.0)
    for (name, p), snap in zip(target.named_parameters(), snapshot):
        assert torch.equal(p.detach(), snap), f"Tham số {name} của target_net đổi theo khi q_net bị sửa: hai mạng đang dùng chung bộ nhớ. target_net phải giữ một bản sao riêng."


def test_sync_soft_update(user, ref):
    """Cập nhật mềm: target ← τ·q + (1 − τ)·target; τ = 0 thì target giữ nguyên"""
    sync = need(user, "sync_target")
    t.seed(1)
    q = ref["QNet"](4, 2, 16)
    t.seed(2)
    target = ref["QNet"](4, 2, 16)
    old = [p.detach().clone() for p in target.parameters()]
    sync(q, target, tau=0.25)
    for (name, p_q), (_, pt), p_old in zip(q.named_parameters(), target.named_parameters(), old):
        t.close(pt, 0.25 * p_q.detach() + 0.75 * p_old, tol=1e-6, what=f"tham số {name} của target_net sau cập nhật mềm với tau = 0,25")
    again = [p.detach().clone() for p in target.parameters()]
    sync(q, target, tau=0.0)
    for (name, pt), before in zip(target.named_parameters(), again):
        assert torch.equal(pt.detach(), before), f"Với tau = 0, tham số {name} của target_net phải giữ nguyên."


def test_train_step_matches_reference(user, ref):
    """Một bước dqn_train_step cho đúng loss và đúng tham số q_net như bản chuẩn (cùng buffer, cùng rng, SGD)"""
    step = need(user, "dqn_train_step")
    q_u, _, losses_u = _run_steps(step, ref, 1)
    q_r, _, losses_r = _run_steps(ref["dqn_train_step"], ref, 1)
    t.close(losses_u[0], losses_r[0], tol=1e-5, what="loss mà dqn_train_step trả về")
    for (name, p_u), (_, p_r) in zip(q_u.named_parameters(), q_r.named_parameters()):
        t.close(p_u, p_r, tol=1e-5, what=f"tham số {name} của q_net sau một bước (sai thì xem lại: bốc batch, mạng nào tính loss, mạng nào được cập nhật)")


def test_train_step_clears_old_gradients(user, ref):
    """Qua ba bước liên tiếp vẫn khớp bản chuẩn: gradient của bước trước không được cộng dồn vào bước sau"""
    step = need(user, "dqn_train_step")
    q_u, _, _ = _run_steps(step, ref, 3)
    q_r, _, _ = _run_steps(ref["dqn_train_step"], ref, 3)
    for (name, p_u), (_, p_r) in zip(q_u.named_parameters(), q_r.named_parameters()):
        t.close(p_u, p_r, tol=1e-5, what=f"tham số {name} của q_net sau ba bước liên tiếp")


def test_train_step_leaves_target_alone(user, ref):
    """target_net không đổi và không nhận gradient sau khi học: chỉ q_net được cập nhật"""
    step = need(user, "dqn_train_step")
    t.seed(4)
    expected = ref["QNet"](4, 2, 16)
    _, target, _ = _run_steps(step, ref, 2)
    for (name, p), p_exp in zip(target.named_parameters(), expected.parameters()):
        assert p.grad is None, f"Tham số {name} của target_net có gradient: loss chỉ được truyền gradient vào q_net."
        assert torch.equal(p.detach(), p_exp.detach()), f"Tham số {name} của target_net đã bị đổi trong bước học: chỉ sync_target mới được đổi nó."


def test_train_step_returns_float(user, ref):
    """dqn_train_step trả về loss là một số Python (float), không phải tensor còn dính đồ thị tính gradient"""
    _, _, losses = _run_steps(need(user, "dqn_train_step"), ref, 1)
    assert isinstance(losses[0], float), f"dqn_train_step trả về {type(losses[0]).__name__}, cần float Python (để ghi vào danh sách loss mà không giữ cả đồ thị trong bộ nhớ)."


def test_train_step_waits_for_data(user, ref):
    """Buffer có ít transition hơn batch_size: trả về None, không báo lỗi và không đổi q_net"""
    step = need(user, "dqn_train_step")
    t.seed(3)
    expected = ref["QNet"](4, 2, 16)
    q, _, losses = _run_steps(step, ref, 1, buffer_size=5)
    assert losses[0] is None, f"Buffer mới có 5 transition, ít hơn batch_size = 16: dqn_train_step phải trả về None, bạn trả về {losses[0]!r}."
    for (name, p), p_exp in zip(q.named_parameters(), expected.parameters()):
        assert torch.equal(p.detach(), p_exp.detach()), f"Tham số {name} của q_net đã đổi dù buffer chưa đủ dữ liệu để học."
