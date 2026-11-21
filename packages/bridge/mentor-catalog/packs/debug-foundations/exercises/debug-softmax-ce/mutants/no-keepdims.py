def log_softmax(z, axis=-1):
    z = np.asarray(z, dtype=float)
    m = z.max(axis=axis)
    s = z - m
    return s - np.log(np.exp(s).sum(axis=axis))


def cross_entropy(logits, targets):
    lp = log_softmax(logits)
    return float(-lp[np.arange(len(targets)), targets].mean())
