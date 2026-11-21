def test_shapes_and_orthonormal(user, ref):
    """Shape đúng và các thành phần chính trực chuẩn"""
    t.seed(0)
    X = np.random.randn(25, 6) + np.arange(6) * 3.0
    Z, comp, evr = need(user, "pca_fit_transform")(X, 3)
    t.shape(Z, (25, 3), what="Z")
    t.shape(comp, (3, 6), what="components")
    t.shape(evr, (3,), what="evr")
    t.close(comp @ comp.T, np.eye(3), tol=1e-6, what="comp @ comp.T")


def test_centered_and_reconstruction(user, ref):
    """Dữ liệu được quy tâm và tái tạo khớp lời giải chuẩn (bất biến dấu SVD)"""
    t.seed(1)
    X = np.random.randn(30, 5) @ np.random.randn(5, 5) + np.array([10.0, -5.0, 2.0, 0.0, 8.0])
    X_copy = X.copy()
    Z, comp, evr = need(user, "pca_fit_transform")(X, 2)
    Zr, compr, evrr = ref["pca_fit_transform"](X, 2)
    t.close(X, X_copy, what="X không bị sửa tại chỗ")
    t.close(Z.mean(axis=0), np.zeros(2), tol=1e-6, what="trung bình của Z phải bằng 0")
    t.close(Z @ comp, Zr @ compr, tol=1e-5, what="tái tạo rank-k")
    t.close(evr, evrr, tol=1e-6, what="explained variance ratio")


def test_variance_ordering_and_full_rank(user, ref):
    """Tỉ lệ phương sai giảm dần và khi k = min(N, D) tổng evr bằng 1"""
    t.seed(2)
    X = np.random.randn(12, 4) * np.array([1.0, 4.0, 0.5, 2.0])
    Z, comp, evr = need(user, "pca_fit_transform")(X, 4)
    assert np.all(np.diff(evr) <= 1e-12), "evr phải sắp theo thứ tự giảm dần."
    t.close(evr.sum(), 1.0, tol=1e-6, what="tổng evr khi k=D")
    t.close(Z @ comp + X.mean(axis=0, keepdims=True), X, tol=1e-5, what="tái tạo đầy đủ")


def test_constant_matrix_edge(user, ref):
    """Ca biên mọi mẫu giống hệt nhau (tổng phương sai bằng 0)"""
    X = np.full((8, 4), 3.5)
    Z, comp, evr = need(user, "pca_fit_transform")(X, 2)
    t.shape(Z, (8, 2), what="Z")
    t.close(Z, np.zeros((8, 2)), what="Z khi X hằng số")
    t.close(evr, np.zeros(2), what="evr khi tổng phương sai bằng 0")
