def pairwise_sqdist(X, Y):
    X = np.asarray(X, dtype=float)
    Y = np.asarray(Y, dtype=float)
    diff = X[:, None, :] - Y[None, :, :]
    return (diff ** 2).sum(axis=-1)
