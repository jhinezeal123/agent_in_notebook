import warnings


def _data(B=6, C=5, seed=0, scale=1.0):
    rng = np.random.default_rng(seed)
    return rng.normal(size=(B, C)) * scale, rng.integers(0, C, size=B)


def test_eps_zero(user, ref):
    """eps = 0 cho đúng cross-entropy thường"""
    f = need(user, "smoothed_cross_entropy")
    logits, targets = _data(seed=1)
    out = float(f(logits, targets, eps=0.0))
    want = ref["smoothed_cross_entropy"](logits, targets, eps=0.0)
    assert np.isclose(out, want), f"Ra {out:.5f}, cần {want:.5f}: với eps = 0 phải là -log softmax của lớp đúng, trung bình trên batch."


def test_values(user, ref):
    """Đúng giá trị với eps = 0.1 (ε/C chia cho cả C lớp)"""
    f = need(user, "smoothed_cross_entropy")
    logits, targets = _data(B=8, C=5, seed=2, scale=2.0)
    out = float(f(logits, targets, eps=0.1))
    want = ref["smoothed_cross_entropy"](logits, targets, eps=0.1)
    assert np.isclose(out, want), f"Ra {out:.5f}, cần {want:.5f}: target là (1−ε)·onehot + ε/C trên cả C lớp, loss là −Σ_c q_c log p_c."


def test_eps_respected(user, ref):
    """Tôn trọng tham số eps (0.3) và số lớp C"""
    f = need(user, "smoothed_cross_entropy")
    logits, targets = _data(B=5, C=7, seed=3, scale=3.0)
    out = float(f(logits, targets, eps=0.3))
    want = ref["smoothed_cross_entropy"](logits, targets, eps=0.3)
    assert np.isclose(out, want), f"Ra {out:.5f}, cần {want:.5f} với eps = 0.3, C = 7."


def test_minimum_not_zero(user, ref):
    """Loss nhỏ nhất là entropy của q, không phải 0"""
    f = need(user, "smoothed_cross_entropy")
    C, e = 4, 0.2
    q = np.full(C, e / C)
    q[2] += 1 - e
    best = float(f(np.log(q)[None, :], np.array([2]), eps=e))
    entropy = float(-(q * np.log(q)).sum())
    assert np.isclose(best, entropy), f"Tại softmax(z) = q loss phải bằng H(q) = {entropy:.5f}, ra {best:.5f}."
    sharper = float(f(3 * np.log(q)[None, :], np.array([2]), eps=e))
    assert sharper > best, "Logits tự tin hơn mức q phải làm loss TĂNG: cross-entropy với q nhỏ nhất khi softmax(z) = q."


def test_batch_mean(user, ref):
    """Trung bình trên batch, không phải tổng"""
    f = need(user, "smoothed_cross_entropy")
    logits, targets = _data(B=6, C=4, seed=4)
    one = float(f(logits, targets, eps=0.1))
    two = float(f(np.concatenate([logits, logits]), np.concatenate([targets, targets]), eps=0.1))
    assert np.isclose(one, two), "Nhân đôi batch (lặp lại y hệt) mà loss đổi: phải lấy trung bình trên batch."
    assert np.isclose(one, ref["smoothed_cross_entropy"](logits, targets, eps=0.1)), "Giá trị chưa đúng."


def test_stable(user, ref):
    """Logits rất lớn (1000) không ra inf/nan"""
    f = need(user, "smoothed_cross_entropy")
    logits = np.array([[1000.0, 0.0, 0.0], [0.0, 1000.0, 0.0]])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        out = float(f(logits, np.array([0, 1]), eps=0.1))
    assert np.isfinite(out), "Ra inf/nan với logits lớn: cần log-softmax ổn định số (trừ max)."
    assert np.isclose(out, 200 / 3, rtol=1e-6), f"Ra {out}, cần ≈ 66.667 (mỗi lớp sai nhận ε/C = 1/30 và có log p ≈ −1000)."
