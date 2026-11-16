def pairwise_sqdist(X, Y):
    diff = np.asarray(X, float)[:, None, :] - np.asarray(Y, float)[None, :, :]
    return (diff ** 2).sum(axis=0)
