def cosine_sim(X, Y, eps=1e-8):
    X = np.asarray(X, dtype=float)
    Y = np.asarray(Y, dtype=float)
    nx = np.maximum(np.sqrt((X * X).sum(axis=1)), eps)
    ny = np.maximum(np.sqrt((Y * Y).sum(axis=1)), eps)
    return (X / nx[:, None]) @ (Y / ny[:, None]).T
