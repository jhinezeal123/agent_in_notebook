def cosine_sim(X, Y, eps=1e-8):
    X = np.asarray(X, dtype=float)
    Y = np.asarray(Y, dtype=float)
    nx = np.linalg.norm(X, axis=1)
    ny = np.linalg.norm(Y, axis=1)
    return (X @ Y.T) / (nx[:, None] * ny[None, :])
