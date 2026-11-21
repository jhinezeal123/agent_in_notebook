def pairwise_sqdist(X, Y):
    diff = np.asarray(Y, float)[:, None, :] - np.asarray(X, float)[None, :, :]
    return (diff ** 2).sum(axis=-1)
