def attention(Q, K, V, mask=None):
    scores = np.einsum("...td,...sd->...ts", Q, K) / np.sqrt(Q.shape[-1])
    if mask is not None:
        scores = np.where(mask, scores, -np.inf)
    w = np.exp(scores)
    w = w / w.sum(-1, keepdims=True)
    return w @ V, w
