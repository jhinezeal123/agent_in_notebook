def test_scores_shape(user, ref):
    """batched_scores có shape (B, H, T, S)"""
    f = need(user, "batched_scores")
    rng = np.random.default_rng(0)
    Q = rng.normal(size=(2, 3, 4, 5))
    K = rng.normal(size=(2, 3, 6, 5))
    out = np.asarray(f(Q, K))
    assert out.shape == (2, 3, 4, 6), f"Shape là {out.shape}, cần (2, 3, 4, 6)."


def test_scores_values(user, ref):
    """batched_scores đúng giá trị (T ≠ S)"""
    f = need(user, "batched_scores")
    rng = np.random.default_rng(1)
    Q = rng.normal(size=(2, 2, 3, 4))
    K = rng.normal(size=(2, 2, 5, 4))
    out = np.asarray(f(Q, K))
    want = ref["batched_scores"](Q, K)
    assert out.shape == want.shape, f"Shape là {out.shape}, cần {want.shape}."
    assert np.allclose(out, want), "Giá trị chưa đúng: kiểm lại trục nào bị cộng, và thứ tự trục ở đầu ra."


def test_bilinear_shape(user, ref):
    """bilinear có shape (B,)"""
    f = need(user, "bilinear")
    rng = np.random.default_rng(2)
    out = np.asarray(f(rng.normal(size=(7, 3)), rng.normal(size=(3, 4)), rng.normal(size=(7, 4))))
    assert out.shape == (7,), f"Shape là {out.shape}, cần (7,)."


def test_bilinear_values(user, ref):
    """bilinear đúng giá trị"""
    f = need(user, "bilinear")
    rng = np.random.default_rng(3)
    x, W, y = rng.normal(size=(5, 3)), rng.normal(size=(3, 6)), rng.normal(size=(5, 6))
    out = np.asarray(f(x, W, y))
    want = np.array([x[b] @ W @ y[b] for b in range(5)])
    assert np.allclose(out, want), "Giá trị chưa đúng."
