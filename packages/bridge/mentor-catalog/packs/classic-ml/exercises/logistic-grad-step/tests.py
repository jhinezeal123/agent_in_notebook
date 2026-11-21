def test_loss_and_grad_match_numeric(user, ref):
    """Loss và gradient khớp cả lời giải chuẩn lẫn sai phân trung tâm"""
    t.seed(5)
    X = np.random.randn(20, 4)
    y = (np.random.rand(20) > 0.4).astype(float)
    w = np.random.randn(4) * 0.5
    b = 0.3
    loss, dw, db = need(user, "logistic_loss_and_grad")(X, y, w, b, lam=0.2)
    lr_, dwr, dbr = ref["logistic_loss_and_grad"](X, y, w, b, lam=0.2)
    t.close(loss, lr_, tol=1e-7, what="loss")
    t.close(dw, dwr, tol=1e-6, what="dw")
    t.close(db, dbr, tol=1e-6, what="db")
    # Sai phân trung tâm cho b
    eps = 1e-6
    lp = need(user, "logistic_loss_and_grad")(X, y, w, b + eps, lam=0.2)[0]
    lm = need(user, "logistic_loss_and_grad")(X, y, w, b - eps, lam=0.2)[0]
    t.close(db, (lp - lm) / (2 * eps), tol=1e-5, what="db khớp sai phân")


def test_extreme_logits_stability(user, ref):
    """Không sinh NaN hoặc inf khi logits đạt +1000 hoặc -1000"""
    X = np.array([[1000.0, 0.0], [-1000.0, 0.0], [1000.0, 0.0], [-1000.0, 0.0]])
    y = np.array([1.0, 0.0, 0.0, 1.0])
    w = np.array([1.0, 0.0])
    loss, dw, db = need(user, "logistic_loss_and_grad")(X, y, w, 0.0, lam=0.0)
    assert np.isfinite(loss), f"Loss bị tràn khi |z|=1000: {loss}"
    assert np.all(np.isfinite(dw)) and np.isfinite(db), "Gradient bị tràn khi |z|=1000."
    t.close(loss, 500.0, tol=1e-5, what="loss đúng bằng 500 trên 2 mẫu đoán sai hoàn toàn")


def test_l2_not_on_bias(user, ref):
    """Phạt L2 chỉ tác động lên w, không tác động lên db"""
    t.seed(8)
    X = np.random.randn(15, 3)
    y = (np.random.rand(15) > 0.5).astype(float)
    w = np.array([1.0, -2.0, 0.5])
    b = 4.0
    _, dw0, db0 = need(user, "logistic_loss_and_grad")(X, y, w, b, lam=0.0)
    _, dw1, db1 = need(user, "logistic_loss_and_grad")(X, y, w, b, lam=3.0)
    t.close(dw1 - dw0, 3.0 * w, tol=1e-7, what="đóng góp L2 vào dw")
    t.close(db1, db0, tol=1e-7, what="db không phụ thuộc lam")


def test_step_reduces_loss_and_no_mutation(user, ref):
    """Một bước logistic_step làm giảm loss và không sửa w gốc tại chỗ"""
    t.seed(9)
    X = np.random.randn(30, 3)
    y = (X[:, 0] - 0.5 * X[:, 1] > 0).astype(float)
    w = np.zeros(3)
    w_copy = w.copy()
    w1, b1, l0 = need(user, "logistic_step")(X, y, w, 0.0, lr=0.5, lam=0.01)
    t.close(w, w_copy, what="w gốc không bị sửa")
    l1 = need(user, "logistic_loss_and_grad")(X, y, w1, b1, lam=0.01)[0]
    assert l1 < l0, f"Loss phải giảm sau 1 bước GD ({l1} không nhỏ hơn {l0})."
