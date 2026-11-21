def pairwise_sqdist(X, Y):
    diff = np.asarray(X, float)[:, None, :] - np.asarray(Y, float)[None, :, :]
    return np.abs(diff).sum(axis=-1)
