def _softmax(x, axis=-1):
    x = x - x.max(axis=axis, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=axis, keepdims=True)


def attention_temp(Q, K, V, tau=1.0, mask=None):
    Q, K, V = (np.asarray(a, dtype=float) for a in (Q, K, V))
    scores = Q @ np.swapaxes(K, -1, -2) / (tau * np.sqrt(Q.shape[-1]))
    if mask is not None:
        scores = np.where(mask, scores, -np.inf)
    weights = _softmax(scores, axis=-1)
    return weights @ V, weights
