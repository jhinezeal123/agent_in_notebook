def batched_scores(Q, K):
    return np.einsum("bhtd,bhsd->bhst", Q, K)


def bilinear(x, W, y):
    return np.einsum("bn,nm,bm->b", x, W, y)
