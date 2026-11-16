def _xor(n, seed, noise=0.35):
    rng = np.random.default_rng(seed)
    centers = np.array([[-1, -1], [1, 1], [-1, 1], [1, -1]], dtype=float)
    labels = np.array([0, 0, 1, 1])
    idx = rng.integers(0, 4, size=n)
    return centers[idx] + rng.normal(scale=noise, size=(n, 2)), labels[idx]


def _trained(user):
    X, y = _xor(400, seed=0)
    res = need(user, "train")(X.copy(), y.copy())
    assert isinstance(res, tuple) and len(res) == 2, "train phải trả về (params, losses)."
    return X, y, res[0], [float(l) for l in res[1]]


def test_losses(user, ref):
    """Loss hữu hạn, mỗi epoch một giá trị, và giảm rõ"""
    X, y, params, losses = _trained(user)
    assert len(losses) == 60, f"Có {len(losses)} giá trị loss, cần 60 (mỗi epoch một giá trị)."
    assert np.isfinite(losses).all(), "Loss có nan/inf."
    assert losses[-1] < 0.5 * losses[0], f"Loss chỉ giảm từ {losses[0]:.3f} xuống {losses[-1]:.3f}."


def test_train_accuracy(user, ref):
    """Độ chính xác trên tập train ≥ 95%"""
    X, y, params, _ = _trained(user)
    acc = float((np.asarray(need(user, "predict")(params, X)) == y).mean())
    assert acc >= 0.95, f"Độ chính xác train {acc:.0%}."


def test_heldout_accuracy(user, ref):
    """Độ chính xác trên tập kiểm tra ≥ 95%"""
    _, _, params, _ = _trained(user)
    Xt, yt = _xor(400, seed=1)
    acc = float((np.asarray(need(user, "predict")(params, Xt)) == yt).mean())
    assert acc >= 0.95, f"Độ chính xác trên tập kiểm tra {acc:.0%}."


def test_inputs_untouched(user, ref):
    """train không làm đổi X, y của người gọi"""
    X, y = _xor(200, seed=2)
    Xc, yc = X.copy(), y.copy()
    need(user, "train")(X, y, epochs=2)
    assert np.array_equal(X, Xc) and np.array_equal(y, yc), "train làm thay đổi X hoặc y truyền vào."
