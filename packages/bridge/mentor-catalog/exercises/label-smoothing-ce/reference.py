def smoothed_cross_entropy(logits, targets, eps=0.1):
    z = np.asarray(logits, dtype=float)
    targets = np.asarray(targets)
    B, C = z.shape
    s = z - z.max(axis=-1, keepdims=True)
    lp = s - np.log(np.exp(s).sum(axis=-1, keepdims=True))
    q = np.full((B, C), eps / C)
    q[np.arange(B), targets] += 1.0 - eps
    return float(-(q * lp).sum(axis=-1).mean())
