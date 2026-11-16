def attention_temp(Q, K, V, tau=1.0, mask=None):
    scores = Q @ np.swapaxes(K, -1, -2) / (tau * np.sqrt(Q.shape[-1]))
    if mask is not None:
        scores = np.where(mask, scores, 0.0)
    scores = scores - scores.max(-1, keepdims=True)
    w = np.exp(scores)
    w = w / w.sum(-1, keepdims=True)
    return w @ V, w
