def _item(i):
    """Transition thứ i, nhận ra được bằng s[0] = i; mọi trường đều suy ra từ i."""
    s = np.array([float(i), i + 0.5, -float(i)])
    return s, i % 4, 0.5 * i, s + 1000.0, i % 3 == 0


def _fill(cls, capacity, n):
    buf = cls(capacity)
    for i in range(n):
        buf.push(*_item(i))
    return buf


def _ids(batch):
    return [int(round(float(x))) for x in batch[0][:, 0]]


def test_len_is_min_of_pushes_and_capacity(user, ref):
    """len(buffer) = min(số lần push, capacity), kể cả khi trống và khi đã ghi vòng"""
    cls = need(user, "ReplayBuffer")
    buf = cls(5)
    assert len(buf) == 0, f"Bộ đệm mới tạo phải có len 0, bạn ra {len(buf)}."
    for k in range(1, 13):
        buf.push(*_item(k))
        assert len(buf) == min(k, 5), f"Sau {k} lần push vào bộ đệm sức chứa 5, len = {len(buf)}, cần {min(k, 5)}."


def test_sample_shapes_and_dtypes(user, ref):
    """sample trả (states (B, d) float32, actions (B,) int64, rewards (B,) float32, next_states (B, d) float32, dones (B,) float32)"""
    cls = need(user, "ReplayBuffer")
    buf = _fill(cls, 10, 6)
    out = buf.sample(4, np.random.default_rng(0))
    assert isinstance(out, tuple) and len(out) == 5, "sample phải trả về bộ năm (states, actions, rewards, next_states, dones)."
    for name, x, shp, dt in zip(["states", "actions", "rewards", "next_states", "dones"], out, [(4, 3), (4,), (4,), (4, 3), (4,)], [np.float32, np.int64, np.float32, np.float32, np.float32]):
        assert isinstance(x, np.ndarray), f"{name} phải là np.ndarray, bạn trả về {type(x).__name__}."
        assert x.shape == shp, f"Shape của {name} là {x.shape}, cần {shp}."
        assert x.dtype == dt, f"dtype của {name} là {x.dtype}, cần {np.dtype(dt)} (đưa thẳng vào mạng nơ-ron mà không phải ép kiểu)."
    buf2 = cls(3)
    buf2.push(np.array([1, 2], dtype=np.int32), np.int32(2), 1, np.array([3, 4], dtype=np.float32), np.bool_(True))
    out = buf2.sample(1, np.random.default_rng(0))
    assert out[0].dtype == np.float32 and out[1].dtype == np.int64 and out[4].dtype == np.float32, "Dù kiểu của đầu vào là gì (int32, bool, float64…), đầu ra vẫn phải đúng dtype."
    assert out[4][0] == 1.0 and out[1][0] == 2, f"done = True phải thành 1.0 và a = 2 giữ nguyên; bạn ra done = {out[4][0]}, a = {out[1][0]}."


def test_transition_stays_together(user, ref):
    """Mỗi hàng của batch là MỘT transition nguyên vẹn: s, a, r, s', done cùng một lần push"""
    cls = need(user, "ReplayBuffer")
    buf = _fill(cls, 30, 25)
    for seed in range(5):
        batch = buf.sample(10, np.random.default_rng(seed))
        ids = np.array(_ids(batch))
        t.close(batch[0][:, 1], ids + 0.5, what="cột thứ hai của states")
        assert np.array_equal(batch[1], ids % 4), f"actions {batch[1].tolist()} không khớp states (id {ids.tolist()}): action của transition i phải là i % 4. Các mảng có bốc cùng một chỉ số không?"
        t.close(batch[2], 0.5 * ids, what="rewards")
        t.close(batch[3], batch[0] + 1000.0, what="next_states (phải là s + 1000 của đúng transition đó)")
        assert np.array_equal(batch[4], (ids % 3 == 0).astype(np.float32)), f"dones {batch[4].tolist()} không khớp với id {ids.tolist()} (done của transition i là i % 3 == 0, dạng 1.0 hoặc 0.0)."


def test_overwrites_oldest(user, ref):
    """Bộ đệm đầy: transition mới ghi đè cái cũ nhất, không bỏ transition mới, không ghi đè bừa"""
    cls = need(user, "ReplayBuffer")
    buf = _fill(cls, 5, 12)
    got = sorted(_ids(buf.sample(5, np.random.default_rng(0))))
    assert got == [7, 8, 9, 10, 11], f"Sức chứa 5, push 12 transition (id 0..11): bộ đệm phải giữ 5 cái mới nhất (7..11); bạn đang giữ {got}."
    buf = _fill(cls, 4, 4)
    assert sorted(_ids(buf.sample(4, np.random.default_rng(1)))) == [0, 1, 2, 3], "Vừa đủ đầy (4 push, sức chứa 4): phải giữ nguyên cả bốn."
    buf.push(*_item(4))
    got = sorted(_ids(buf.sample(4, np.random.default_rng(2))))
    assert got == [1, 2, 3, 4], f"Thêm transition thứ 5 vào bộ đệm đầy: cái cũ nhất (id 0) phải bị ghi đè; bạn đang giữ {got}."
    for i in range(5, 11):
        buf.push(*_item(i))
    got = sorted(_ids(buf.sample(4, np.random.default_rng(3))))
    assert got == [7, 8, 9, 10], f"Sau khi ghi vòng quanh hơn một vòng, phải giữ 4 cái mới nhất (7..10); bạn đang giữ {got}."


def test_sample_without_replacement(user, ref):
    """Một batch không có transition nào xuất hiện hai lần; bốc cả bộ đệm thì ra mỗi cái đúng một lần"""
    cls = need(user, "ReplayBuffer")
    buf = _fill(cls, 20, 20)
    for seed in range(30):
        ids = _ids(buf.sample(8, np.random.default_rng(seed)))
        assert len(set(ids)) == 8, f"Batch 8 có transition lặp (id {sorted(ids)}): bốc không thay thế."
    ids = sorted(_ids(buf.sample(20, np.random.default_rng(0))))
    assert ids == list(range(20)), f"Bốc cả 20 transition phải ra mỗi cái đúng một lần; bạn ra {ids}."


def test_only_written_entries(user, ref):
    """Chỉ bốc trong phần đã ghi (bộ đệm sức chứa lớn mới ghi ít), không lấy ô trống"""
    cls = need(user, "ReplayBuffer")
    buf = _fill(cls, 100, 7)
    ids = sorted(_ids(buf.sample(7, np.random.default_rng(0))))
    assert ids == list(range(7)), f"Sức chứa 100 nhưng mới push 7: bốc 7 phải ra đúng 7 transition đó (id 0..6); bạn ra {ids}. Bạn đang bốc trong phạm vi nào: số đã ghi hay sức chứa?"
    for seed in range(40):
        ids = _ids(buf.sample(3, np.random.default_rng(seed)))
        assert all(0 <= i < 7 for i in ids), f"Bốc ra id {ids} ngoài các transition đã ghi (0..6)."


def test_sample_errors(user, ref):
    """Bốc nhiều hơn số đang có, bốc 0 hay bốc từ bộ đệm trống: raise ValueError"""
    cls = need(user, "ReplayBuffer")
    rng = np.random.default_rng(0)
    for n_pushed, batch_size, what in [(0, 1, "bộ đệm trống"), (3, 4, "batch lớn hơn số đang có"), (3, 0, "batch_size = 0"), (6, 7, "batch lớn hơn số đang có (bộ đệm đầy 6)")]:
        buf = _fill(cls, 6, n_pushed)
        try:
            buf.sample(batch_size, rng)
        except ValueError:
            continue
        except Exception as e:
            raise AssertionError(f"{what} (có {n_pushed} phần tử, batch {batch_size}): cần ValueError, bạn ra {type(e).__name__}.")
        raise AssertionError(f"{what} (có {n_pushed} phần tử, batch {batch_size}): phải raise ValueError, nhưng sample trả kết quả bình thường.")


def test_copies_inputs(user, ref):
    """push lưu bản sao: người gọi sửa hoặc tái dùng mảng của họ không làm hỏng transition đã lưu"""
    cls = need(user, "ReplayBuffer")
    buf = cls(10)
    s, s2 = np.zeros(2), np.ones(2)
    for i in range(4):
        s[:] = i
        s2[:] = i + 100
        buf.push(s, i, float(i), s2, False)
    s[:] = -1
    s2[:] = -1
    batch = buf.sample(4, np.random.default_rng(0))
    got = sorted(batch[0][:, 0].tolist())
    assert got == [0.0, 1.0, 2.0, 3.0], f"Người gọi dùng lại một mảng s cho mọi push (và sửa tại chỗ): states trong bộ đệm phải là [0, 1, 2, 3], bạn có {got}. push có chép dữ liệu không?"
    got = sorted(batch[3][:, 0].tolist())
    assert got == [100.0, 101.0, 102.0, 103.0], f"next_states trong bộ đệm phải là [100..103] dù người gọi sửa mảng sau đó, bạn có {got}."


def test_uniform_and_uses_given_rng(user, ref):
    """Bốc đều (mỗi transition cùng xác suất) và chỉ dùng rng được truyền vào: cùng seed cùng batch"""
    cls = need(user, "ReplayBuffer")
    buf = _fill(cls, 10, 10)
    rng = np.random.default_rng(0)
    counts = np.zeros(10)
    for _ in range(3000):
        for i in _ids(buf.sample(3, rng)):
            counts[i] += 1
    freq = counts / 3000
    assert np.all(np.abs(freq - 0.3) < 0.04), f"Batch 3 trong 10 transition: mỗi cái lẽ ra có mặt trong khoảng 30% số batch; bạn ra {np.round(freq, 2).tolist()}."
    np.random.seed(5)
    a = _ids(buf.sample(4, np.random.default_rng(42)))
    np.random.seed(6)
    b = _ids(buf.sample(4, np.random.default_rng(42)))
    assert a == b, f"Cùng seed của rng nhưng batch khác nhau ({a} và {b}): mọi lựa chọn ngẫu nhiên phải đi qua rng được truyền vào."
    others = {tuple(_ids(buf.sample(4, np.random.default_rng(seed)))) for seed in range(10)}
    assert len(others) >= 3, "Mười seed khác nhau chỉ cho ra vài batch giống nhau: rng có thật sự được dùng không?"
