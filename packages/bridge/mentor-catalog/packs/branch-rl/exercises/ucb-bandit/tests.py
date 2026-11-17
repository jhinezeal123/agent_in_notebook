def _strict(f, *args):
    with np.errstate(divide="raise", invalid="raise"):
        return f(*args)


def test_hand_examples(user, ref):
    """Điểm UCB tính tay: tay ít thử được cộng bonus lớn, tay đã thử nhiều thì bonus nhỏ"""
    f = need(user, "select_ucb")
    got = f(np.array([1.0, 0.0]), np.array([100, 1]), 101, 1.0)
    assert int(got) == 1, f"q = [1, 0], n = [100, 1], t = 101, c = 1: bonus của tay 1 là sqrt(ln 101 / 1) ≈ 2.15 còn của tay 0 chỉ ≈ 0.21. Bạn chọn tay {got}, cần tay 1."
    got = f(np.array([1.0, 0.9]), np.array([100, 100]), 201, 1.0)
    assert int(got) == 0, f"Hai tay cùng n nên cùng bonus, q quyết định: cần tay 0, bạn chọn tay {got}."
    got = f(np.array([1.0, 0.9]), np.array([400, 4]), 405, 0.5)
    assert int(got) == 1, f"q = [1, 0.9], n = [400, 4], t = 405, c = 0.5: điểm tay 0 ≈ 1.06, tay 1 ≈ 1.51; cần tay 1, bạn chọn tay {got}."


def test_unvisited_first(user, ref):
    """Tay chưa thử (n = 0) được chọn trước, nhỏ nhất trước, và không có phép chia cho 0"""
    f = need(user, "select_ucb")
    q = np.array([100.0, 0.0, 50.0, -3.0])
    got = _strict(f, q, np.array([5, 0, 3, 0]), 9, 1.0)
    assert int(got) == 1, f"Tay 1 và tay 3 chưa thử: phải chọn tay có chỉ số nhỏ nhất trong chúng (tay 1), dù tay 0 có q = 100. Bạn chọn tay {got}."
    got = _strict(f, q, np.array([5, 4, 3, 0]), 13, 1.0)
    assert int(got) == 3, f"Chỉ tay 3 chưa thử: phải chọn nó dù q của nó thấp nhất. Bạn chọn tay {got}."
    got = _strict(f, np.zeros(3), np.zeros(3, dtype=np.int64), 1, 2.0)
    assert int(got) == 0, f"Lượt đầu tiên (t = 1, mọi tay chưa thử, ln 1 = 0): cần tay 0, bạn chọn tay {got}."
    got = _strict(f, np.array([0.3]), np.array([0]), 1, 1.0)
    assert int(got) == 0, f"Chỉ một tay: cần 0, bạn ra {got}."


def test_matches_reference_random(user, ref):
    """Nhiều trường hợp ngẫu nhiên (K, n, t, c khác nhau, có tay chưa thử): khớp lời giải chuẩn"""
    f = need(user, "select_ucb")
    r = ref["select_ucb"]
    rng = np.random.default_rng(0)
    for i in range(300):
        k = int(rng.integers(2, 9))
        q = rng.standard_normal(k)
        n = rng.integers(1, 60, size=k)
        if i % 4 == 0:
            n[rng.integers(k)] = 0
        t = int(n.sum()) + 1
        c = float(rng.choice([0.0, 0.5, 1.0, 2.0, 3.0]))
        got, want = _strict(f, q.copy(), n.copy(), t, c), r(q, n, t, c)
        assert int(got) == int(want), f"Lệch ở ca {i}: q = {np.round(q, 3).tolist()}, n = {n.tolist()}, t = {t}, c = {c}: bạn chọn tay {got}, cần tay {want}."


def test_c_extremes(user, ref):
    """c = 0 là greedy thuần; c rất lớn thì chỉ còn quan tâm tay ít được thử nhất"""
    f = need(user, "select_ucb")
    q = np.array([0.2, 0.9, 0.5, 0.1])
    n = np.array([30, 10, 50, 20])
    got = _strict(f, q, n, 111, 0.0)
    assert int(got) == 1, f"c = 0: không còn bonus, phải chọn tay có q lớn nhất (tay 1); bạn chọn tay {got}."
    got = _strict(f, q, n, 111, 1e6)
    assert int(got) == 1, f"c rất lớn: bonus lấn át, tay ít thử nhất là tay 1 (n = 10); bạn chọn tay {got}."
    got = _strict(f, np.array([5.0, -5.0, 0.0]), np.array([30, 50, 40]), 121, 1e6)
    assert int(got) == 0, f"c rất lớn, n = [30, 50, 40]: tay ít thử nhất là tay 0; bạn chọn tay {got}."
    got = _strict(f, np.array([5.0, 9.0, 0.0]), np.array([40, 40, 40]), 121, 1e6)
    assert int(got) == 1, f"Mọi bonus bằng nhau thì q quyết định: cần tay 1, bạn chọn tay {got}."


def test_bonus_grows_with_t(user, ref):
    """Cùng q và n, t càng lớn thì bonus càng lớn: tay ít thử cuối cùng cũng được chọn lại"""
    f = need(user, "select_ucb")
    q, n = np.array([1.0, 0.5]), np.array([50, 5])
    got = _strict(f, q, n, 2, 1.0)
    assert int(got) == 0, f"t = 2: ln t còn nhỏ, bonus chưa đủ bù chênh lệch q; cần tay 0, bạn chọn tay {got}."
    got = _strict(f, q, n, 1000, 1.0)
    assert int(got) == 1, f"t = 1000: ln t lớn hơn nhiều, tay 1 (ít thử) phải được chọn; bạn chọn tay {got}."


def test_inputs_untouched_and_tie(user, ref):
    """Không sửa q và n của người gọi; đồng điểm chọn chỉ số nhỏ nhất; trả về số nguyên"""
    f = need(user, "select_ucb")
    q, n = np.array([0.5, 0.5, 0.5]), np.array([4, 4, 4])
    q0, n0 = q.copy(), n.copy()
    got = _strict(f, q, n, 13, 1.0)
    assert np.array_equal(q, q0) and np.array_equal(n, n0), f"Hàm sửa đầu vào: q = {q}, n = {n}, ban đầu {q0}, {n0}."
    assert int(got) == 0, f"Ba tay hoàn toàn như nhau: lấy tay có chỉ số nhỏ nhất (0), bạn chọn {got}."
    assert isinstance(got, (int, np.integer)), f"Trả về {type(got).__name__}, cần một số nguyên chỉ số tay."
    q2, n2 = np.array([1.0, 2.0]), np.array([0, 7])
    n2_0 = n2.copy()
    _strict(f, q2, n2, 8, 1.0)
    assert np.array_equal(n2, n2_0), f"n bị sửa thành {n2} (ban đầu {n2_0}): đừng 'sửa' n = 0 thành 1 để tránh chia cho 0."


def test_full_loop_finds_best(user, ref):
    """Chạy cả vòng bandit (update của bạn ở bài trước): UCB dồn lượt vào tay tốt nhất mà vẫn thử mọi tay"""
    f = need(user, "select_ucb")
    upd = need(user, "update")
    steps, k = 1500, 4
    gen = np.random.default_rng(0)
    means = np.array([0.2, 0.5, 1.0, 0.4])
    rewards = means + 0.3 * gen.standard_normal((steps, k))
    q, n = np.zeros(k), np.zeros(k, dtype=np.int64)
    for step in range(1, steps + 1):
        a = int(_strict(f, q, n, step, 1.0))
        assert 0 <= a < k, f"Lượt {step}: select_ucb trả về {a}, ngoài [0, {k})."
        upd(q, n, a, rewards[step - 1, a])
    assert np.all(n > 0), f"Mọi tay phải được thử ít nhất một lần; n = {n.tolist()}."
    assert n[2] > 0.6 * steps, f"Tay tốt nhất (tay 2) chỉ được kéo {n[2]}/{steps} lần: n = {n.tolist()}."
    assert n[:2].min() >= 5 and n[3] >= 5, f"UCB vẫn phải thỉnh thoảng thử lại các tay khác; n = {n.tolist()}."
