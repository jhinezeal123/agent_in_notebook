def test_cubic_central_accuracy(user, ref):
    """Sai phân trung tâm đạt độ chính xác O(eps^2) trên hàm bậc 3 (bắt sai phân tiến)"""
    t.seed(0)
    x = np.array([1.2, -0.7, 2.3, 0.5])
    f = lambda a: float(np.sum(a ** 3 + 0.5 * a ** 2))
    exact = 3.0 * (x ** 2) + x
    got = need(user, "numerical_grad")(f, x, eps=1e-4)
    # Sai phân tiến ở eps=1e-4 lệch ~3e-4, sai phân trung tâm lệch ~1e-8
    t.close(got, exact, tol=1e-6, what="gradient hàm bậc 3")


def test_multidimensional_and_no_mutation(user, ref):
    """Hoạt động với mảng 2D/3D và không sửa x tại chỗ"""
    t.seed(4)
    W = np.random.randn(2, 3)
    X = np.random.randn(3, 4)
    X_orig = X.copy()
    f = lambda arr: float(np.sum((W @ arr) ** 2))
    got = need(user, "numerical_grad")(f, X, eps=1e-5)
    want = ref["numerical_grad"](f, X, eps=1e-5)
    t.shape(got, (3, 4), what="gradient shape")
    t.close(X, X_orig, what="X không bị sửa tại chỗ")
    t.close(got, want, tol=1e-6, what="gradient 2D")


def test_rel_error_values_and_zeros(user, ref):
    """grad_rel_error đúng giá trị và an toàn khi cả hai gradient bằng 0"""
    fn = need(user, "grad_rel_error")
    ga = np.array([[1.0, -2.0], [3.0, 0.0]])
    gn = ga + np.array([[1e-5, -1e-5], [0.0, 1e-5]])
    t.close(fn(ga, gn), ref["grad_rel_error"](ga, gn), tol=1e-9, what="rel error")
    t.close(fn(np.zeros((2, 2)), np.zeros((2, 2))), 0.0, tol=1e-12, what="gradient toàn 0")


def test_integer_input_array(user, ref):
    """Đầu vào mảng số nguyên được ép sang float trước khi cộng trừ eps"""
    x = np.array([1, 2, 3])
    f = lambda a: float(np.sum(a ** 2))
    got = need(user, "numerical_grad")(f, x, eps=1e-5)
    t.close(got, np.array([2.0, 4.0, 6.0]), tol=1e-5, what="đầu vào int")
