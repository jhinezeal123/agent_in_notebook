def _table(seed, steps=300, means=(0.5, 1.0, 2.0, 1.5, 0.8), noise=0.05):
    rng = np.random.default_rng(seed)
    means = np.asarray(means, dtype=float)
    return means + noise * rng.standard_normal((steps, len(means)))


def _picks(f, q, eps, seed, n):
    rng = np.random.default_rng(seed)
    q = np.asarray(q, dtype=float)
    return np.array([int(f(q, eps, rng)) for _ in range(n)])


def test_update_incremental_mean(user, ref):
    """update: Q của một tay là trung bình cộng các thưởng đã nhận (lần đầu Q bằng đúng r)"""
    upd = need(user, "update")
    q, n = np.zeros(3), np.zeros(3, dtype=np.int64)
    rs = [2.0, 4.0, 9.0, -1.0, 6.0]
    for i, r in enumerate(rs, 1):
        upd(q, n, 1, r)
        assert n[1] == i, f"Sau {i} lần kéo tay 1, n[1] = {n[1]}, cần {i}."
        assert abs(q[1] - np.mean(rs[:i])) < 1e-9, f"Sau {i} lần kéo tay 1, q[1] = {q[1]:.6f}, cần trung bình {np.mean(rs[:i]):.6f}. n trong công thức là số lần tính cả lần này."
    assert q[0] == 0 and q[2] == 0 and n[0] == 0 and n[2] == 0, f"Tay khác tay 1 không được đổi: q = {q}, n = {n}."
    q, n = np.full(3, 5.0), np.zeros(3, dtype=np.int64)
    upd(q, n, 2, 1.5)
    assert q[2] == 1.5 and n[2] == 1, f"Lần kéo đầu tiên phải quên giá trị khởi tạo: q[2] = {q[2]}, n[2] = {n[2]}, cần 1.5 và 1."


def test_update_in_place(user, ref):
    """update sửa q và n tại chỗ (các mảng người gọi truyền vào), chỉ đổi phần tử của tay a"""
    upd = need(user, "update")
    q = np.array([1.0, 2.0, 3.0, 4.0])
    n = np.array([1, 2, 3, 4], dtype=np.int64)
    q0, n0 = q.copy(), n.copy()
    upd(q, n, 2, 7.0)
    want_q, want_n = q0.copy(), n0.copy()
    ref["update"](want_q, want_n, 2, 7.0)
    assert not (np.array_equal(q, q0) and np.array_equal(n, n0)), "Mảng q và n của người gọi không đổi sau update: hàm phải sửa tại chỗ, không trả về mảng mới."
    t.close(q, want_q, what="q sau update")
    assert np.array_equal(n, want_n), f"n sau update là {n}, cần {want_n}: chỉ tay đã kéo tăng 1."


def test_greedy_picks_best(user, ref):
    """eps = 0: luôn chọn tay có q lớn nhất, không bao giờ khám phá"""
    f = need(user, "select_action")
    q = np.array([0.1, -0.5, 0.9, 0.3, 0.8])
    got = _picks(f, q, 0.0, 0, 300)
    assert set(got) == {2}, f"eps = 0 và tay 2 có q lớn nhất, nhưng bạn đã chọn các tay {sorted(set(got))}."
    got = _picks(f, -np.arange(4.0), 0.0, 1, 100)
    assert set(got) == {0}, f"Mọi q không dương, tay 0 lớn nhất (-0): bạn chọn {sorted(set(got))}."


def test_tie_break_random(user, ref):
    """Đồng hạng giá trị lớn nhất: chọn ngẫu nhiên đều giữa các tay đó, không thiên về tay đầu"""
    f = need(user, "select_action")
    n = 3000
    got = _picks(f, [1.0, 1.0, 0.0, 1.0], 0.0, 2, n)
    counts = np.bincount(got, minlength=4) / n
    assert counts[2] == 0, f"Tay 2 có q thấp hơn nhưng bị chọn {counts[2]:.0%} số lần khi eps = 0."
    assert np.all(np.abs(counts[[0, 1, 3]] - 1 / 3) < 0.05), f"Ba tay đồng hạng phải được chọn khoảng 1/3 mỗi tay; bạn ra {np.round(counts, 3)}."
    firsts = {int(f(np.zeros(6), 0.0, np.random.default_rng(s))) for s in range(40)}
    assert len(firsts) >= 4, f"Lúc đầu mọi q = 0: qua 40 seed khác nhau lẽ ra phải thấy nhiều tay khác nhau, bạn chỉ chọn {sorted(firsts)}."


def test_epsilon_rate(user, ref):
    """Khám phá chọn đều trong CẢ K tay: tay tốt nhất được chọn 1 - eps + eps/K lần"""
    f = need(user, "select_action")
    n = 5000
    q = [0.0, 0.0, 1.0, 0.0]
    counts = np.bincount(_picks(f, q, 0.4, 3, n), minlength=4) / n
    assert abs(counts[2] - 0.7) < 0.04, f"Với eps = 0.4, K = 4, tay tốt nhất lẽ ra được chọn khoảng 0.7 số lần; bạn ra {counts[2]:.3f}. Khám phá có thể rơi vào tay tốt nhất không?"
    assert np.all(np.abs(counts[[0, 1, 3]] - 0.1) < 0.03), f"Mỗi tay còn lại lẽ ra được chọn khoảng 0.1; bạn ra {np.round(counts[[0, 1, 3]], 3)}."
    counts = np.bincount(_picks(f, q, 1.0, 4, n), minlength=4) / n
    assert np.all(np.abs(counts - 0.25) < 0.04), f"eps = 1 phải chọn đều ngẫu nhiên: mỗi tay khoảng 0.25, bạn ra {np.round(counts, 3)}."


def test_uses_given_rng(user, ref):
    """Mọi lựa chọn ngẫu nhiên đi qua rng được truyền vào: cùng seed cùng kết quả, kể cả khi seed toàn cục đổi"""
    f = need(user, "select_action")
    q = np.array([0.5, 0.5, 0.2, 0.5, 0.1])
    np.random.seed(111)
    a = _picks(f, q, 0.3, 7, 60)
    np.random.seed(222)
    b = _picks(f, q, 0.3, 7, 60)
    assert np.array_equal(a, b), "Cùng một seed của rng nhưng kết quả khác nhau khi seed toàn cục đổi: bạn đang dùng np.random.* thay vì rng."
    c = _picks(f, q, 0.3, 8, 60)
    assert not np.array_equal(a, c), "Hai rng khác seed cho đúng cùng một chuỗi chọn: rng có thật sự được dùng không?"


def test_run_bookkeeping(user, ref):
    """run_bandit: hình dạng kết quả, n khớp số lần chọn, q là trung bình thưởng của từng tay"""
    run = need(user, "run_bandit")
    rw = _table(0)
    out = run(rw, 0.3, np.random.default_rng(0))
    assert isinstance(out, tuple) and len(out) == 3, "run_bandit phải trả về bộ ba (q, n, actions)."
    q, n, actions = out
    t.shape(q, (5,), what="q")
    t.shape(n, (5,), what="n")
    t.shape(actions, (300,), what="actions")
    assert int(np.sum(n)) == 300, f"Tổng n là {int(np.sum(n))}, cần 300 (một lần kéo mỗi lượt)."
    assert np.array_equal(np.bincount(actions, minlength=5), n), "n không khớp số lần mỗi tay xuất hiện trong actions."
    for a in range(5):
        mask = actions == a
        want = rw[mask, a].mean() if mask.any() else 0.0
        assert abs(q[a] - want) < 1e-9, f"q[{a}] = {q[a]:.5f}, cần bằng trung bình các thưởng đã nhận từ tay {a} ({want:.5f}) ở các lượt nó được chọn."


def test_run_greedy_locks_in(user, ref):
    """eps = 0 với thưởng dương: tay đầu tiên (chọn ngẫu nhiên lúc hòa) giữ mãi, và lúc đầu tay nào cũng có thể được chọn"""
    run = need(user, "run_bandit")
    rw = _table(1)
    firsts = set()
    for seed in range(20):
        q, n, actions = run(rw, 0.0, np.random.default_rng(seed))
        assert len(set(actions.tolist())) == 1, f"eps = 0, mọi thưởng dương: sau lần kéo đầu tay đó có q > 0 = các tay khác, nên phải giữ mãi. Bạn chọn các tay {sorted(set(actions.tolist()))}."
        firsts.add(int(actions[0]))
        assert n[actions[0]] == 300, f"n của tay được chọn là {n[actions[0]]}, cần 300."
    assert len(firsts) >= 3, f"Qua 20 seed lượt đầu (mọi q hòa) chỉ ra các tay {sorted(firsts)}: hòa phải chọn ngẫu nhiên."


def test_run_finds_best_arm(user, ref):
    """eps = 0.1 trên bandit có một tay rõ ràng tốt nhất: dồn phần lớn lượt vào nó và ước lượng gần đúng"""
    run = need(user, "run_bandit")
    rw = _table(2, steps=2000, means=(0.0, 0.3, 1.0, 0.5, 0.2), noise=0.3)
    q, n, actions = run(rw, 0.1, np.random.default_rng(5))
    assert n[2] > 0.8 * 2000, f"Tay tốt nhất (tay 2) chỉ được kéo {n[2]}/2000 lần; với eps = 0.1 lẽ ra khoảng 92%."
    assert n[2] < 0.99 * 2000, f"Tay 2 được kéo {n[2]}/2000 lần: gần như không khám phá, dù eps = 0.1."
    assert abs(q[2] - 1.0) < 0.1, f"q[2] = {q[2]:.3f}, cần gần 1.0 (giá trị thật của tay 2)."
    rw_u = _table(3, steps=1000)
    _, n, _ = run(rw_u, 1.0, np.random.default_rng(6))
    assert np.all(np.abs(n - 200) < 55), f"eps = 1: mỗi tay lẽ ra được kéo khoảng 200 lần, bạn ra {n.tolist()}."
