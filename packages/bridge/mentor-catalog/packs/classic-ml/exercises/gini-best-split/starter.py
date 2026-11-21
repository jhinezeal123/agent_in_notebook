def gini_impurity(y):
    """Tính độ bất thuần Gini 1 - sum(p_c^2) cho mảng nhãn 1D y; rỗng trả 0.0."""
    raise NotImplementedError


def best_split(X, y):
    """Tìm (feature, threshold, gain) tối đa hóa độ giảm Gini; không chia được trả (None, None, 0.0)."""
    raise NotImplementedError
