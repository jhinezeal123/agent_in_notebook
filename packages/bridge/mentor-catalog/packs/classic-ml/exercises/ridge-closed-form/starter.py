def ridge_fit(X, y, lam=1.0):
    """Giải nghiệm đóng Ridge (không phạt bias). Trả về (w, b)."""
    raise NotImplementedError


def ridge_predict(X, w, b):
    """Dự đoán y_hat = X @ w + b có shape (N,)."""
    raise NotImplementedError
