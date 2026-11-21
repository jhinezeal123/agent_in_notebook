def test_shapes_and_values(user, ref):
    """Khớp nghiệm đóng trên dữ liệu ngẫu nhiên nhiều chiều"""
    t.seed(0)
    X = np.random.randn(40, 5) + np.array([3.0, -2.0, 0.5, 1.0, -4.0])
    w_true = np.array([1.5, -0.8, 2.2, 0.0, -1.1])
    y = X @ w_true + 7.5 + np.random.randn(40) * 0.3
    w, b = need(user, "ridge_fit")(X, y, lam=0.5)
    wr, br = ref["ridge_fit"](X, y, lam=0.5)
    t.shape(w, (5,), what="w")
    t.close(w, wr, tol=1e-6, what="w")
    t.close(b, br, tol=1e-6, what="b")
    pred = need(user, "ridge_predict")(X, w, b)
    t.shape(pred, (40,), what="ridge_predict")
    t.close(pred, ref["ridge_predict"](X, wr, br), tol=1e-6, what="dự đoán")


def test_bias_not_penalized(user, ref):
    """Hệ số bias b không bị kéo về 0 ngay cả khi lam rất lớn"""
    t.seed(1)
    X = np.random.randn(30, 3)
    y = np.full(30, 100.0) + np.random.randn(30) * 0.1
    w, b = need(user, "ridge_fit")(X, y, lam=1e6)
    t.close(w, np.zeros(3), tol=1e-3, what="w phải tiến về 0 khi lam rất lớn")
    t.close(b, float(y.mean()), tol=1e-2, what="b phải xấp xỉ mean(y), không bị phạt")


def test_scaling_by_n_matters(user, ref):
    """Phạt L2 đúng tỉ lệ với hàm mất mát trung bình 1/N (không phải tổng không chia N)"""
    t.seed(2)
    X = np.random.randn(60, 4)
    y = X @ np.array([2.0, -1.0, 0.5, 1.0]) + 1.0
    w, b = need(user, "ridge_fit")(X, y, lam=2.0)
    wr, br = ref["ridge_fit"](X, y, lam=2.0)
    t.close(w, wr, tol=1e-6, what="w với hàm mục tiêu có 1/N")
    t.close(b, br, tol=1e-6, what="b")


def test_collinear_and_zero_lam(user, ref):
    """Chạy ổn định khi đặc trưng phụ thuộc tuyến tính với lam > 0 và khớp OLS khi lam = 0"""
    t.seed(3)
    X = np.random.randn(25, 3)
    y = X @ np.array([1.0, -2.0, 0.5]) + 3.0
    w0, b0 = need(user, "ridge_fit")(X, y, lam=0.0)
    t.close(w0, np.array([1.0, -2.0, 0.5]), tol=1e-6, what="OLS khi lam=0")
    t.close(b0, 3.0, tol=1e-6, what="bias OLS")
    X_col = np.column_stack([X[:, 0], X[:, 0]])
    wc, bc = need(user, "ridge_fit")(X_col, y, lam=0.1)
    wr, br = ref["ridge_fit"](X_col, y, lam=0.1)
    t.close(wc, wr, tol=1e-6, what="đa cộng tuyến")
    t.close(bc, br, tol=1e-6, what="bias đa cộng tuyến")
