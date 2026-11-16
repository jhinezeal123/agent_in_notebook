def batched_scores(Q, K):
    return np.einsum("bhtd,bhsd->bhts", Q, K)


def bilinear(x, W, y):
    return np.einsum("bn,nm,bm->bn", x, W, y)
