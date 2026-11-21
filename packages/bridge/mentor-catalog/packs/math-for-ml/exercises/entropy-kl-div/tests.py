def test_entropy_values_and_zeros(user, ref):
    """Entropy đúng với phân bố đều, one-hot (có phần tử 0) và batch 2D"""
    fn = need(user, "shannon_entropy")
    t.close(fn(np.array([0.25, 0.25, 0.25, 0.25])), np.log(4), tol=1e-6, what="phân bố đều")
    t.close(fn(np.array([1.0, 0.0, 0.0])), 0.0, tol=1e-6, what="one-hot")
    P = np.array([[0.5, 0.5, 0.0], [0.2, 0.3, 0.5]])
    t.close(fn(P), ref["shannon_entropy"](P), tol=1e-6, what="batch 2D")


def test_kl_values_and_asymmetry(user, ref):
    """KL đúng giá trị, bằng 0 khi p == q, và bất đối xứng khi p != q"""
    fn = need(user, "kl_divergence")
    p = np.array([[0.7, 0.2, 0.1], [0.5, 0.5, 0.0]])
    q = np.array([[0.2, 0.5, 0.3], [0.5, 0.5, 0.0]])
    t.close(fn(p, q), ref["kl_divergence"](p, q), tol=1e-6, what="KL(p||q)")
    t.close(fn(p, p), np.zeros(2), tol=1e-6, what="KL(p||p)")
    assert abs(float(fn(p[0], q[0])) - float(fn(q[0], p[0]))) > 1e-3, "KL(p||q) phải khác KL(q||p)."


def test_kl_zero_support_edges(user, ref):
    """Xử lý đúng 0*log(0/0) = 0 và p>0, q=0 cho +inf"""
    fn = need(user, "kl_divergence")
    p = np.array([0.5, 0.5, 0.0])
    q_same_zero = np.array([0.2, 0.8, 0.0])
    t.close(fn(p, q_same_zero), ref["kl_divergence"](p, q_same_zero), tol=1e-6, what="cùng bằng 0 tại vị trí cuối")
    q_bad = np.array([0.0, 1.0, 0.0])
    got = fn(p, q_bad)
    assert np.isposinf(got), f"Khi p_i > 0 mà q_i == 0, KL phải là +inf (nhận {got})."


def test_gibbs_inequality_batch(user, ref):
    """KL luôn không âm trên batch ngẫu nhiên và khớp lời giải chuẩn"""
    t.seed(19)
    raw_p = np.random.exponential(size=(10, 6))
    raw_q = np.random.exponential(size=(10, 6))
    P = raw_p / raw_p.sum(axis=-1, keepdims=True)
    Q = raw_q / raw_q.sum(axis=-1, keepdims=True)
    got = need(user, "kl_divergence")(P, Q)
    t.shape(got, (10,), what="shape KL")
    assert np.all(got >= -1e-12), "KL divergence không được âm (bất đẳng thức Gibbs)."
    t.close(got, ref["kl_divergence"](P, Q), tol=1e-6, what="KL ngẫu nhiên")
