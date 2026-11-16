def cosine_sim(X, Y, eps=1e-8):
    X = np.asarray(X, dtype=float)
    Y = np.asarray(Y, dtype=float)
    nx = np.maximum(np.linalg.norm(X, axis=0, keepdims=True), eps)
    ny = np.maximum(np.linalg.norm(Y, axis=0, keepdims=True), eps)
    return (X / nx) @ (Y / ny).T
