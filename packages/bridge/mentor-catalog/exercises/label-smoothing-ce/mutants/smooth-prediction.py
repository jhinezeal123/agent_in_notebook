def smoothed_cross_entropy(logits, targets, eps=0.1):
    z = np.asarray(logits, dtype=float)
    B, C = z.shape
    s = z - z.max(axis=-1, keepdims=True)
    p = np.exp(s) / np.exp(s).sum(axis=-1, keepdims=True)
    p = (1.0 - eps) * p + eps / C
    return float(-np.log(p[np.arange(B), targets]).mean())
