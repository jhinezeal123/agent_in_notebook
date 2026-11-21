def pca_fit_transform(X, k):
    X = np.asarray(X, dtype=float)
    Xc = X - X.mean(axis=0, keepdims=True)
    _U, S, Vt = np.linalg.svd(Xc, full_matrices=False)
    components = Vt[-k:]
    Z = Xc @ components.T
    sq = S ** 2
    total = float(sq.sum())
    evr = sq[-k:] / total if total > 0 else np.zeros(k, dtype=float)
    return Z, components, evr
