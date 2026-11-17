def test_hand_example(user, ref):
    """Một episode, gamma = 0.5: tính tay từ bước cuối ngược về bước đầu"""
    f = need(user, "returns_to_go")
    got = np.asarray(f(np.array([1.0, 2.0, 3.0]), 0.5), dtype=float)
    t.shape(got, (3,), what="G")
    assert np.allclose(got, [2.75, 3.5, 3.0], atol=1e-9), (
        f"rewards = [1, 2, 3], gamma = 0.5: bước cuối G = 3; bước giữa G = 2 + 0.5 * 3 = 3.5; bước đầu G = 1 + 0.5 * 3.5 = 2.75. "
        f"Bạn ra {np.round(got, 4).tolist()}. Bạn tính theo chiều nào, và gamma đứng ở đâu?"
    )


def test_gamma_edges(user, ref):
    """gamma = 0 chỉ giữ thưởng tức thời, gamma = 1 là tổng thưởng còn lại, và thưởng ở cuối bị chiết khấu dần khi lùi về trước"""
    f = need(user, "returns_to_go")
    r = np.array([1.0, -2.0, 0.5, 4.0])
    got = np.asarray(f(r, 0.0), dtype=float)
    assert np.allclose(got, r), f"gamma = 0: G_t chỉ còn r_t = {r.tolist()}; bạn ra {np.round(got, 4).tolist()}."
    got = np.asarray(f(r, 1.0), dtype=float)
    assert np.allclose(got, [3.5, 2.5, 4.5, 4.0]), f"gamma = 1: G_t là tổng các thưởng từ bước t đến hết = [3.5, 2.5, 4.5, 4]; bạn ra {np.round(got, 4).tolist()}."
    got = np.asarray(f(np.array([0.0, 0.0, 0.0, 1.0]), 0.9), dtype=float)
    assert np.allclose(got, [0.729, 0.81, 0.9, 1.0]), (
        f"Chỉ bước cuối có thưởng 1, gamma = 0.9: bước lùi k bước so với cuối phải bị chiết khấu k lần = [0.729, 0.81, 0.9, 1]; bạn ra {np.round(got, 4).tolist()}."
    )


def test_episode_boundaries(user, ref):
    """Nhiều episode nối tiếp: dones đánh dấu bước cuối, tích lũy không được tràn qua ranh giới"""
    f = need(user, "returns_to_go")
    r = np.ones(6)
    d = np.array([0, 0, 1, 0, 0, 1])
    got = np.asarray(f(r, 0.9, d), dtype=float)
    want = [2.71, 1.9, 1.0, 2.71, 1.9, 1.0]
    assert np.allclose(got, want, atol=1e-9), (
        f"Hai episode ba bước, thưởng 1 mỗi bước, gamma = 0.9: mỗi episode cho [2.71, 1.9, 1.0]. Bạn ra {np.round(got, 4).tolist()}. "
        f"Thưởng của episode sau có lọt vào G của episode trước không, hoặc bước done có bị cộng thừa không?"
    )
    d2 = np.array([1, 1, 1, 1, 1, 1])
    got = np.asarray(f(np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]), 0.9, d2), dtype=float)
    assert np.allclose(got, [1, 2, 3, 4, 5, 6]), f"Mọi bước đều là bước cuối của episode một bước: G_t = r_t. Bạn ra {np.round(got, 4).tolist()}."
    r3 = np.array([5.0, 0.0, 0.0, 7.0, 0.0])
    got = np.asarray(f(r3, 0.5, np.array([0, 1, 0, 0, 1])), dtype=float)
    assert np.allclose(got, [5.0, 0.0, 3.5, 7.0, 0.0], atol=1e-9), (
        f"rewards = [5, 0, 0, 7, 0], done ở bước 1 và 4, gamma = 0.5: cần [5, 0, 3.5, 7, 0]. Bạn ra {np.round(got, 4).tolist()}. "
        f"Thưởng 5 ở bước 0 có đến được bước nào ở episode sau không?"
    )


def test_truncated_tail_not_bootstrapped(user, ref):
    """Mảng kết thúc mà không có done: bước cuối chỉ có thưởng của chính nó, và các bước trước không phụ thuộc gì phía sau"""
    f = need(user, "returns_to_go")
    r = np.array([1.0, 1.0, 1.0, 2.0, 3.0])
    d = np.array([0, 0, 1, 0, 0])
    got = np.asarray(f(r, 0.5, d), dtype=float)
    assert np.isclose(got[4], 3.0), f"Bước cuối (không done) bị cắt ngang: G = r = 3, không cộng thêm gì; bạn ra {got[4]:.4f}."
    assert np.isclose(got[3], 3.5), f"G của bước 3 = 2 + 0.5 * 3 = 3.5; bạn ra {got[3]:.4f}."
    assert np.allclose(got[:3], [1.75, 1.5, 1.0]), f"Ba bước đầu là một episode đầy đủ = [1.75, 1.5, 1.0]; bạn ra {np.round(got[:3], 4).tolist()}."
    r2 = r.copy()
    r2[3:] = [100.0, -50.0]
    got2 = np.asarray(f(r2, 0.5, d), dtype=float)
    assert np.allclose(got2[:3], got[:3]), "Đổi thưởng ở episode sau làm đổi G của episode trước: ranh giới episode chưa chặn đúng chỗ."


def test_dones_forms_and_list_input(user, ref):
    """dones kiểu bool, 0/1 số nguyên hoặc float và rewards dạng list cho cùng một kết quả"""
    f = need(user, "returns_to_go")
    r = [1.0, 2.0, 0.0, 4.0, 1.0]
    base = np.asarray(f(np.array(r), 0.9, np.array([0.0, 1.0, 0.0, 0.0, 1.0])), dtype=float)
    for d in (np.array([False, True, False, False, True]), np.array([0, 1, 0, 0, 1]), [0, 1, 0, 0, 1], [False, True, False, False, True]):
        got = np.asarray(f(r, 0.9, d), dtype=float)
        assert np.allclose(got, base), f"dones dạng {type(d).__name__} (dtype {getattr(d, 'dtype', 'list')}) cho {np.round(got, 4).tolist()}, cần {np.round(base, 4).tolist()}."
    got = np.asarray(f(r, 0.9, None), dtype=float)
    want = np.asarray(ref["returns_to_go"](r, 0.9), dtype=float)
    assert np.allclose(got, want), f"dones = None nghĩa là cả mảng một episode: cần {np.round(want, 4).tolist()}, bạn ra {np.round(got, 4).tolist()}."


def test_matches_reference_random(user, ref):
    """Nhiều dãy thưởng, gamma và cách chia episode ngẫu nhiên (kể cả dãy dài): khớp lời giải chuẩn"""
    f = need(user, "returns_to_go")
    rng = np.random.default_rng(0)
    for i in range(60):
        n = int(rng.integers(1, 40)) if i < 55 else 3000
        r = rng.standard_normal(n)
        d = (rng.random(n) < 0.15).astype(np.float32) if i % 3 else None
        g = float(rng.choice([0.0, 0.5, 0.9, 0.99, 1.0]))
        got = np.asarray(f(r, g, d), dtype=float)
        want = np.asarray(ref["returns_to_go"](r, g, d), dtype=float)
        t.shape(got, (n,), what=f"G (ca {i})")
        assert np.allclose(got, want, atol=1e-6, rtol=1e-6), (
            f"Lệch ở ca {i} (T = {n}, gamma = {g}, {'có' if d is not None else 'không có'} dones): lệch lớn nhất {np.abs(got - want).max():.2e}."
        )


def test_dtype_and_inputs_untouched(user, ref):
    """Trả về mảng float dù thưởng là số nguyên; không sửa rewards và dones của người gọi"""
    f = need(user, "returns_to_go")
    r = np.array([1, 0, 0, 1], dtype=np.int64)
    d = np.array([0, 0, 0, 1], dtype=np.int64)
    r0, d0 = r.copy(), d.copy()
    got = np.asarray(f(r, 0.5, d))
    assert np.issubdtype(got.dtype, np.floating), f"Thưởng là số nguyên nhưng G phải là số thực; bạn trả về dtype {got.dtype} (0.5 bị làm tròn xuống 0?)."
    assert np.allclose(got, [1.125, 0.25, 0.5, 1.0]), f"rewards = [1, 0, 0, 1], done ở cuối, gamma = 0.5: cần [1.125, 0.25, 0.5, 1]; bạn ra {np.round(got, 4).tolist()}."
    assert np.array_equal(r, r0), f"rewards của người gọi bị sửa: {r.tolist()} (ban đầu {r0.tolist()}). Hãy dùng một mảng kết quả riêng."
    assert np.array_equal(d, d0), f"dones của người gọi bị sửa: {d.tolist()} (ban đầu {d0.tolist()})."
    rf = np.array([2.0, 3.0, 4.0])
    rf0 = rf.copy()
    f(rf, 0.9)
    assert np.array_equal(rf, rf0), f"rewards (float) của người gọi bị sửa: {rf.tolist()} (ban đầu {rf0.tolist()})."


def test_short_sequences(user, ref):
    """Dãy một phần tử và dãy rỗng"""
    f = need(user, "returns_to_go")
    got = np.asarray(f(np.array([2.5]), 0.9), dtype=float)
    assert got.shape == (1,) and np.isclose(got[0], 2.5), f"Một bước, không done: G = r = 2.5; bạn ra {got.tolist()}."
    got = np.asarray(f(np.array([2.5]), 0.9, np.array([1])), dtype=float)
    assert got.shape == (1,) and np.isclose(got[0], 2.5), f"Một bước, done: G = r = 2.5; bạn ra {got.tolist()}."
    got = np.asarray(f(np.array([]), 0.9), dtype=float)
    assert got.shape == (0,), f"Dãy rỗng phải trả về mảng rỗng shape (0,); bạn ra shape {got.shape}."
