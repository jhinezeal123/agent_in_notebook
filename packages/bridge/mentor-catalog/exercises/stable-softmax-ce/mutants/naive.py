def log_softmax(z, axis=-1):
    z = np.asarray(z, dtype=float)
    return np.log(np.exp(z) / np.exp(z).sum(axis=axis, keepdims=True))


def cross_entropy(logits, targets):
    lp = log_softmax(logits)
    return float(-lp[np.arange(len(targets)), targets].mean())
