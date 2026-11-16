def attention(Q, K, V, mask=None):
    scores = Q @ np.swapaxes(K, -1, -2) / np.sqrt(Q.shape[-1])
    scores = scores - scores.max(-1, keepdims=True)
    w = np.exp(scores)
    w = w / w.sum(-1, keepdims=True)
    if mask is not None:
        w = w * mask
    return w @ V, w
