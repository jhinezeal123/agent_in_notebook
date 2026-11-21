def ridge_fit(X, y, lam=1.0):
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float).ravel()
    N, D = X.shape
    x_mean = X.mean(axis=0)
    y_mean = float(y.mean())
    Xc = X - x_mean
    yc = y - y_mean
    A = (Xc.T @ Xc) / N + float(lam) * np.eye(D)
    rhs = (Xc.T @ yc) / N
    w = np.linalg.solve(A, rhs)
    b = y_mean - float(x_mean @ w)
    return w, float(b)


def ridge_predict(X, w, b):
    X = np.asarray(X, dtype=float)
    w = np.asarray(w, dtype=float)
    return X @ w + float(b)
