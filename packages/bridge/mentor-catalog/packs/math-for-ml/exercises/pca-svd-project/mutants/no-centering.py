def pca_fit_transform(X, k):
    X = np.asarray(X, dtype=float)
    _U, S, Vt = np.linalg.svd(X, full_matrices=False)
    components = Vt[:k]
    Z = X @ components.T
    sq = S ** 2
    total = float(sq.sum())
    evr = sq[:k] / total if total > 0 else np.zeros(k, dtype=float)
    return Z, components, evr
