def smoothed_cross_entropy(logits, targets, eps=0.1):
    z = np.asarray(logits, dtype=float)
    B, C = z.shape
    p = np.exp(z) / np.exp(z).sum(axis=-1, keepdims=True)
    q = np.full((B, C), eps / C)
    q[np.arange(B), targets] += 1.0 - eps
    return float(-(q * np.log(p)).sum(axis=-1).mean())
