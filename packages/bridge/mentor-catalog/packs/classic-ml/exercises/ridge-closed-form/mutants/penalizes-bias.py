def ridge_fit(X, y, lam=1.0):
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float).ravel()
    N, D = X.shape
    Xa = np.column_stack([X, np.ones(N)])
    theta = np.linalg.solve((Xa.T @ Xa) / N + float(lam) * np.eye(D + 1), (Xa.T @ y) / N)
    return theta[:-1], float(theta[-1])

def ridge_predict(X, w, b):
    return np.asarray(X, float) @ np.asarray(w, float) + float(b)
