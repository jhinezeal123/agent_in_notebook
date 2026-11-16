def log_softmax(z, axis=-1):
    z = np.asarray(z, dtype=float)
    s = z - z.max(axis=axis, keepdims=True)
    return z - np.log(np.exp(s).sum(axis=axis, keepdims=True))


def cross_entropy(logits, targets):
    lp = log_softmax(logits)
    return float(-lp[np.arange(len(targets)), targets].mean())
