class _Chain:
    """Hành lang 5 ô: hành động 0 = trái, 1 = phải. Thưởng 1 khi tới ô 4 (đích, hết episode), còn lại 0."""
    n_states = 5
    n_actions = 2

    def reset(self):
        self.s, self.t = 0, 0
        return 0

    def step(self, a):
        self.t += 1
        if self.t > 2000:
            raise RuntimeError("Episode dài quá 2000 bước: vòng lặp có dừng khi done = True không?")
        self.s = min(self.s + 1, 4) if a == 1 else max(self.s - 1, 0)
        return self.s, (1.0 if self.s == 4 else 0.0), self.s == 4


class _Spy:
    """Bọc một môi trường để đếm reset, bước, episode kết thúc và hành động đã chọn."""

    def __init__(self, env):
        self.env = env
        self.n_states, self.n_actions = env.n_states, env.n_actions
        self.resets = self.steps = self.finished = 0
        self.actions = []

    def reset(self):
        self.resets += 1
        return self.env.reset()

    def step(self, a):
        self.steps += 1
        self.actions.append(int(a))
        out = self.env.step(a)
        self.finished += bool(out[2])
        return out


def _dist(s, n):
    row, col = divmod(s, n)
    return (n - 1 - row) + (n - 1 - col)


def _table():
    return np.array([[0.0, 0.0, 0.0], [5.0, 1.0, 2.0], [-1.0, -2.0, 9.0], [-5.0, -2.0, -9.0]])


def test_update_formula_by_hand(user, ref):
    """Một bước cập nhật tính tay: target = r + gamma * max Q(s'), Q(s,a) dịch về phía target"""
    f = need(user, "q_update")
    Q = np.array([[1.0, 2.0], [4.0, 6.0]])
    td = f(Q, 0, 1, 1.0, 1, False, 0.5, 0.9)
    assert abs(Q[0, 1] - 4.2) < 1e-9, f"Q = [[1, 2], [4, 6]], s = 0, a = 1, r = 1, s' = 1, alpha = 0.5, gamma = 0.9: target = 1 + 0.9 * 6 = 6.4, Q[0, 1] mới phải là 2 + 0.5 * (6.4 - 2) = 4.2; bạn ra {Q[0, 1]:.4f}."
    assert td is not None and abs(float(td) - 4.4) < 1e-9, f"q_update phải trả về TD error = target - Q cũ = 4.4; bạn trả về {td}."
    assert np.array_equal(Q[[0, 1], [0, 0]], [1.0, 4.0]) and Q[1, 1] == 6.0, f"Chỉ Q[s, a] được đổi; Q bây giờ là {Q.tolist()}."


def test_done_does_not_bootstrap(user, ref):
    """Khi done = True, target chỉ là r: không cộng giá trị của trạng thái sau (nó không tồn tại)"""
    f = need(user, "q_update")
    Q = np.array([[1.0, 2.0], [1e6, 1e6]])
    td = f(Q, 0, 1, 1.0, 1, True, 0.5, 0.9)
    assert abs(Q[0, 1] - 1.5) < 1e-9, f"done = True: target = r = 1, Q[0, 1] mới = 2 + 0.5 * (1 - 2) = 1.5; bạn ra {Q[0, 1]:.4g}. Trạng thái s' sau bước kết thúc có giá trị tương lai không?"
    assert abs(float(td) + 1.0) < 1e-9, f"TD error khi done phải là r - Q cũ = -1; bạn trả về {td}."
    Q = np.array([[0.0, 0.0], [3.0, 4.0]])
    f(Q, 0, 0, 2.0, 1, False, 1.0, 0.5)
    assert abs(Q[0, 0] - 4.0) < 1e-9, f"done = False: target = 2 + 0.5 * 4 = 4; bạn ra {Q[0, 0]:.4g}."


def test_max_over_next_state(user, ref):
    """Bootstrap lấy MAX theo hành động của hàng s' (không phải hàng s, không phải hành động vừa chọn, không phải max cả bảng)"""
    f = need(user, "q_update")
    Q = _table()
    f(Q, 0, 1, 0.5, 1, False, 1.0, 1.0)
    assert abs(Q[0, 1] - 5.5) < 1e-9, f"s' = 1 có Q = [5, 1, 2]: target = 0.5 + max = 5.5, bạn ra {Q[0, 1]:.4g}. Max theo hành động của hàng nào, và có phải của hành động đã chọn không?"
    Q = _table()
    f(Q, 1, 0, 0.0, 3, False, 1.0, 1.0)
    assert abs(Q[1, 0] + 2.0) < 1e-9, f"s' = 3 có Q = [-5, -2, -9] toàn âm: max là -2, target = -2, bạn ra {Q[1, 0]:.4g}."
    Q = _table()
    f(Q, 3, 2, 1.0, 0, False, 1.0, 0.9)
    assert abs(Q[3, 2] - 1.0) < 1e-9, f"s' = 0 có Q toàn 0: target = 1 + 0.9 * 0 = 1, bạn ra {Q[3, 2]:.4g}."


def test_alpha_gamma_edges(user, ref):
    """alpha = 0 không đổi gì, alpha = 1 thay hẳn bằng target, gamma = 0 bỏ qua tương lai; TD error không phụ thuộc alpha"""
    f = need(user, "q_update")
    Q = _table()
    td = f(Q, 0, 2, 2.0, 2, False, 0.0, 0.5)
    assert np.array_equal(Q, _table()), "alpha = 0: Q không được đổi."
    assert abs(float(td) - (2.0 + 0.5 * 9.0)) < 1e-9, f"TD error = target - Q cũ = 6.5 dù alpha = 0; bạn trả về {td}."
    Q = _table()
    f(Q, 2, 0, 3.0, 1, False, 1.0, 0.0)
    assert abs(Q[2, 0] - 3.0) < 1e-9, f"gamma = 0, alpha = 1: Q[2, 0] mới = r = 3, bạn ra {Q[2, 0]:.4g}."
    Q = _table()
    f(Q, 1, 2, 1.0, 2, False, 0.1, 0.9)
    assert abs(Q[1, 2] - (2.0 + 0.1 * (1.0 + 0.9 * 9.0 - 2.0))) < 1e-9, f"alpha = 0.1: Q[1, 2] mới = 2 + 0.1 * (target - 2) = 2.71; bạn ra {Q[1, 2]:.4g}."


def test_updates_in_place(user, ref):
    """q_update sửa đúng mảng Q của người gọi, và Q[s, a] là phần tử duy nhất đổi"""
    f = need(user, "q_update")
    Q = _table()
    keep = Q
    before = Q.copy()
    f(Q, 2, 1, 1.0, 1, False, 0.5, 0.9)
    assert Q is keep, "Q bị thay bằng đối tượng khác."
    changed = np.argwhere(Q != before)
    assert changed.tolist() == [[2, 1]], f"Chỉ Q[2, 1] được đổi, nhưng các phần tử đổi là {changed.tolist()}. Mảng Q của người gọi có được sửa tại chỗ không?"


def test_q_learning_gridworld(user, ref):
    """q_learning trên lưới 4x4: giá trị hội tụ về Q*, chính sách greedy đi đường ngắn nhất tới đích"""
    f = need(user, "q_learning")
    env = ref["GridWorld"](4)
    gamma = 0.95
    Q = f(env, 300, 0.5, gamma, 0.2, np.random.default_rng(0))
    assert isinstance(Q, np.ndarray) and Q.shape == (16, 4), f"Q phải là mảng numpy shape (16, 4); bạn trả về {getattr(Q, 'shape', type(Q))}."
    best = Q.max(axis=1)
    for s in range(15):
        want = -(1 - gamma ** _dist(s, 4)) / (1 - gamma)
        assert abs(best[s] - want) < 0.02, f"Ô {s} cách đích {_dist(s, 4)} bước: giá trị tối ưu = {want:.3f}, bạn học được max Q = {best[s]:.3f}. Cập nhật có dùng đúng s_next, done chưa?"
    env2 = ref["GridWorld"](4)
    s, steps = env2.reset(), 0
    while s != env2.goal and steps < 30:
        s, _, _ = env2.step(int(np.argmax(Q[s])))
        steps += 1
    assert steps == 6, f"Chính sách greedy từ ô 0 cần {steps} bước tới đích, đường ngắn nhất là 6."


def test_q_learning_other_env(user, ref):
    """q_learning không gắn cứng với một lưới: hành lang 5 ô có thưởng 1 ở đích cho Q* = gamma^(số bước còn lại - 1)"""
    f = need(user, "q_learning")
    gamma = 0.9
    Q = f(_Chain(), 500, 0.5, gamma, 0.3, np.random.default_rng(1))
    assert Q.shape == (5, 2), f"Q phải có shape (n_states, n_actions) = (5, 2); bạn trả về {Q.shape}."
    for s in range(4):
        want = gamma ** (3 - s)
        assert abs(Q[s, 1] - want) < 0.02, f"Q[{s}, phải] tối ưu = {want:.3f}, bạn học được {Q[s, 1]:.3f}."
        assert Q[s, 1] > Q[s, 0], f"Ô {s}: đi phải ({Q[s, 1]:.3f}) phải tốt hơn đi trái ({Q[s, 0]:.3f})."


def test_q_learning_episode_loop(user, ref):
    """Mỗi episode: reset đúng một lần và chạy tới khi done; eps = 1 thì hành động đều ngẫu nhiên; cùng seed cùng kết quả"""
    f = need(user, "q_learning")
    spy = _Spy(ref["GridWorld"](4))
    f(spy, 60, 0.5, 0.95, 1.0, np.random.default_rng(2))
    assert spy.resets == 60, f"60 episode nhưng gọi env.reset() {spy.resets} lần: mỗi episode phải reset đúng một lần."
    assert spy.finished == 60, f"Có {spy.finished}/60 episode chạy tới khi done = True: mỗi episode phải chạy tới khi done."
    freq = np.bincount(spy.actions, minlength=4) / len(spy.actions)
    assert np.all(np.abs(freq - 0.25) < 0.04), f"eps = 1: hành động phải chọn đều ngẫu nhiên (mỗi loại khoảng 0.25), bạn ra {np.round(freq, 3)}. eps có thật sự được dùng không?"
    a = f(ref["GridWorld"](4), 40, 0.5, 0.95, 0.3, np.random.default_rng(3))
    np.random.seed(0)
    b = f(ref["GridWorld"](4), 40, 0.5, 0.95, 0.3, np.random.default_rng(3))
    assert np.array_equal(a, b), "Cùng seed của rng nhưng Q khác nhau: mọi lựa chọn ngẫu nhiên phải đi qua rng được truyền vào."
