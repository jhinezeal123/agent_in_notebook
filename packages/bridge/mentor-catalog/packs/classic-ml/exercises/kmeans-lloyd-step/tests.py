def test_assign_shapes_and_values(user, ref):
    """assign_clusters trả đúng shape, dtype nguyên và tâm gần nhất"""
    t.seed(0)
    X = np.random.randn(40, 4)
    C = np.random.randn(5, 4)
    got = need(user, "assign_clusters")(X, C)
    want = ref["assign_clusters"](X, C)
    t.shape(got, (40,), what="labels")
    assert np.issubdtype(np.asarray(got).dtype, np.integer), "labels phải là mảng số nguyên."
    t.close(got, want, tol=0, what="labels")


def test_update_basic_and_no_mutation(user, ref):
    """update_centroids tính đúng trọng tâm mới và không sửa old_centroids"""
    t.seed(2)
    X = np.random.randn(30, 3)
    C = np.random.randn(4, 3)
    C_copy = C.copy()
    labels = ref["assign_clusters"](X, C)
    got = need(user, "update_centroids")(X, labels, C)
    want = ref["update_centroids"](X, labels, C)
    t.close(C, C_copy, what="old_centroids không bị sửa")
    t.shape(got, (4, 3), what="centroids mới")
    t.close(got, want, tol=1e-7, what="centroids mới")


def test_empty_cluster_kept(user, ref):
    """Cụm rỗng giữ nguyên tâm cũ, không sinh NaN"""
    X = np.array([[0.0, 0.0], [0.2, 0.1], [-0.1, 0.2]])
    old = np.array([[0.0, 0.0], [10.0, 10.0], [-5.0, 5.0]])
    labels = np.array([0, 0, 0])
    got = need(user, "update_centroids")(X, labels, old)
    assert np.all(np.isfinite(got)), "Cụm rỗng không được sinh NaN."
    t.close(got[0], X.mean(axis=0), tol=1e-7, what="cụm 0 có điểm")
    t.close(got[1], old[1], tol=1e-7, what="cụm 1 rỗng giữ tâm cũ")
    t.close(got[2], old[2], tol=1e-7, what="cụm 2 rỗng giữ tâm cũ")


def test_monotone_inertia_decrease(user, ref):
    """Hàm mục tiêu (tổng bình phương khoảng cách tới tâm) không tăng qua mỗi bước Lloyd"""
    t.seed(7)
    X = np.random.randn(60, 3)
    C = X[:4].copy()
    inertia = lambda pts, c, l: float(((pts - c[l]) ** 2).sum())
    l0 = need(user, "assign_clusters")(X, C)
    prev = inertia(X, C, l0)
    for _ in range(5):
        C = need(user, "update_centroids")(X, l0, C)
        l0 = need(user, "assign_clusters")(X, C)
        cur = inertia(X, C, l0)
        assert cur <= prev + 1e-9, f"Inertia tăng từ {prev} lên {cur}."
        prev = cur
