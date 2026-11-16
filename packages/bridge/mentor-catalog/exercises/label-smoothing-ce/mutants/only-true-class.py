def smoothed_cross_entropy(logits, targets, eps=0.1):
    z = np.asarray(logits, dtype=float)
    B, C = z.shape
    s = z - z.max(axis=-1, keepdims=True)
    lp = s - np.log(np.exp(s).sum(axis=-1, keepdims=True))
    w = 1.0 - eps + eps / C
    return float(-(w * lp[np.arange(B), targets]).mean())
