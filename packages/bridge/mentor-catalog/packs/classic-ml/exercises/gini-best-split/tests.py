def test_gini_values_and_empty(user, ref):
    """Gini đúng cho nút thuần, chia đều 2 lớp, 3 lớp và mảng rỗng"""
    fn = need(user, "gini_impurity")
    t.close(fn(np.array([1, 1, 1, 1])), 0.0, tol=1e-7, what="nút thuần")
    t.close(fn(np.array([0, 0, 1, 1])), 0.5, tol=1e-7, what="50/50 nhị phân")
    t.close(fn(np.array([0, 1, 2])), 2.0 / 3.0, tol=1e-7, what="đều 3 lớp")
    t.close(fn(np.array([])), 0.0, tol=1e-7, what="mảng rỗng")


def test_best_split_clean_separator(user, ref):
    """Tìm đúng đặc trưng và ngưỡng tách hoàn hảo khi 1 đặc trưng tách lớp rõ"""
    X = np.array([
        [0.0, 1.0],
        [1.0, 2.0],
        [0.0, 3.0],
        [1.0, 7.0],
        [0.0, 8.0],
        [1.0, 9.0],
    ])
    y = np.array([0, 0, 0, 1, 1, 1])
    feat, thr, gain = need(user, "best_split")(X, y)
    assert feat == 1, f"Đặc trưng tách hoàn hảo là cột 1 (nhận {feat})."
    t.close(thr, 5.0, tol=1e-7, what="ngưỡng trung điểm (3+7)/2")
    t.close(gain, 0.5, tol=1e-7, what="độ giảm Gini hoàn hảo")


def test_best_split_multiclass_random(user, ref):
    """Khớp lời giải chuẩn trên dữ liệu nhiều lớp ngẫu nhiên"""
    t.seed(13)
    X = np.random.randn(36, 4)
    y = np.where(X[:, 2] < -0.3, 0, np.where(X[:, 2] < 0.6, 1, 2))
    feat, thr, gain = need(user, "best_split")(X, y)
    fr, tr, gr = ref["best_split"](X, y)
    assert feat == fr, f"Chọn sai đặc trưng tốt nhất: {feat} vs {fr}."
    t.close(thr, tr, tol=1e-7, what="ngưỡng tốt nhất")
    t.close(gain, gr, tol=1e-7, what="gain tốt nhất")


def test_unsplittable_edges(user, ref):
    """Trả (None, None, 0.0) khi nút đã thuần hoặc mọi đặc trưng hằng số"""
    fn = need(user, "best_split")
    assert fn(np.array([[1.0, 2.0], [3.0, 4.0]]), np.array([1, 1])) == (None, None, 0.0)
    assert fn(np.array([[5.0, 2.0], [5.0, 2.0], [5.0, 2.0]]), np.array([0, 1, 0])) == (None, None, 0.0)
