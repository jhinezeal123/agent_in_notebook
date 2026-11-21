def ridge_fit(X, y, lam=1.0):
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float).ravel()
    N, D = X.shape
    xm, ym = X.mean(axis=0), float(y.mean())
    Xc, yc = X - xm, y - ym
    w = np.linalg.solve((Xc.T @ Xc) / N + float(lam) * np.eye(D), (Xc.T @ yc) / N)
    return w, float(ym)

def ridge_predict(X, w, b):
    return np.asarray(X, float) @ np.asarray(w, float) + float(b)
