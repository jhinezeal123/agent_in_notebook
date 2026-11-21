def mystery_block_c(X, Wq, Wk, Wv):
    B, T, D = X.shape
    Q = X @ Wq
    K = X @ Wk
    V = X @ Wv
    d = Q.shape[-1]
    S = (Q @ K.swapaxes(-1, -2)) / np.sqrt(d)
    tri = np.tril(np.ones((T, T), dtype=bool))
    S = np.where(tri, S, -np.inf)
    S = S - S.max(axis=-1, keepdims=True)
    A = np.exp(S)
    A = A / A.sum(axis=-1, keepdims=True)
    Y = A @ V
    return Q, S, A, Y
