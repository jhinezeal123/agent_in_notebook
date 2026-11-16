def attention(Q, K, V, mask=None):
    scores = Q @ np.swapaxes(K, -1, -2) / np.sqrt(Q.shape[-1])
    if mask is not None:
        scores = np.where(mask, scores, -np.inf)
    scores = scores - scores.max(-2, keepdims=True)
    w = np.exp(scores)
    w = w / w.sum(-2, keepdims=True)
    return w @ V, w
