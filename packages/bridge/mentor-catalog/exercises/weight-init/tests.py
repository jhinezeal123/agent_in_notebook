_NAMES = ["xavier_normal", "xavier_uniform", "kaiming_normal", "kaiming_uniform"]


def _draw(user, name, fan_in, fan_out, seed=0):
    W = np.asarray(need(user, name)(fan_in, fan_out, np.random.default_rng(seed)), float)
    assert W.shape == (fan_in, fan_out), f"{name}: shape là {W.shape}, cần (fan_in, fan_out) = {(fan_in, fan_out)}."
    return W


def _check_std(name, W, target):
    assert abs(W.mean()) < 0.02 * target, f"{name}: trung bình {W.mean():.4f} chưa gần 0."
    ratio = W.std() / target
    assert abs(ratio - 1) < 0.03, f"{name}: std đo được {W.std():.4f}, mục tiêu {target:.4f} (lệch ×{ratio:.2f}). Kiểm lại công thức phương sai và tham số bạn đưa cho rng."


def _check_normal_shape(name, W, target):
    tail = np.mean(np.abs(W) > 2 * target)
    assert 0.035 < tail < 0.058, f"{name}: {tail:.1%} giá trị nằm ngoài ±2σ, phân phối chuẩn phải có khoảng 4.6%. Đây có phải phân phối chuẩn không?"


def _check_uniform_shape(name, W, bound):
    m = np.abs(W).max()
    assert m <= bound * (1 + 1e-9), f"{name}: có giá trị {m:.4f} vượt cận {bound:.4f} mà phân phối đều với phương sai mục tiêu phải có."
    assert m > 0.99 * bound, f"{name}: giá trị lớn nhất {m:.4f} còn xa cận {bound:.4f}; phân phối đều phải phủ tới sát cận."


def test_shapes(user, ref):
    """Cả bốn hàm trả về ma trận (fan_in, fan_out)"""
    for name in _NAMES:
        _draw(user, name, 3, 5)


def test_xavier_normal(user, ref):
    """xavier_normal: trung bình 0, std = √(2/(fan_in+fan_out)), dạng chuẩn"""
    W = _draw(user, "xavier_normal", 300, 500, seed=1)
    target = np.sqrt(2 / 800)
    _check_std("xavier_normal", W, target)
    _check_normal_shape("xavier_normal", W, target)


def test_xavier_uniform(user, ref):
    """xavier_uniform: đúng phương sai, bị chặn bởi đúng cận"""
    W = _draw(user, "xavier_uniform", 300, 500, seed=2)
    target = np.sqrt(2 / 800)
    _check_std("xavier_uniform", W, target)
    _check_uniform_shape("xavier_uniform", W, np.sqrt(3) * target)


def test_kaiming_normal(user, ref):
    """kaiming_normal: std = √(2/fan_in), không phụ thuộc fan_out"""
    for fi, fo in [(200, 800), (800, 200)]:
        W = _draw(user, "kaiming_normal", fi, fo, seed=3)
        target = np.sqrt(2 / fi)
        _check_std(f"kaiming_normal({fi}, {fo})", W, target)
        _check_normal_shape("kaiming_normal", W, target)


def test_kaiming_uniform(user, ref):
    """kaiming_uniform: đúng phương sai, bị chặn bởi đúng cận"""
    for fi, fo in [(400, 300), (150, 900)]:
        W = _draw(user, "kaiming_uniform", fi, fo, seed=4)
        target = np.sqrt(2 / fi)
        _check_std(f"kaiming_uniform({fi}, {fo})", W, target)
        _check_uniform_shape("kaiming_uniform", W, np.sqrt(3) * target)


def test_uses_rng(user, ref):
    """Mọi số ngẫu nhiên lấy từ rng truyền vào: cùng seed thì cùng kết quả"""
    for name in _NAMES:
        a = _draw(user, name, 20, 30, seed=7)
        b = _draw(user, name, 20, 30, seed=7)
        c = _draw(user, name, 20, 30, seed=8)
        assert np.array_equal(a, b), f"{name}: cùng một seed mà hai lần gọi ra hai ma trận khác nhau. Số ngẫu nhiên đang lấy từ đâu?"
        assert not np.array_equal(a, c), f"{name}: hai seed khác nhau mà ra cùng ma trận."
