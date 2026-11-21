def shannon_entropy(p):
    p = np.asarray(p, dtype=float)
    pos = p > 0
    terms = np.zeros_like(p)
    terms[pos] = -p[pos] * np.log2(p[pos])
    return terms.sum(axis=-1)

def kl_divergence(p, q):
    p, q = np.broadcast_arrays(np.asarray(p, float), np.asarray(q, float))
    terms = np.zeros_like(p)
    pos = (p > 0) & (q > 0)
    terms[pos] = p[pos] * np.log2(p[pos] / q[pos])
    terms[(p > 0) & (q == 0)] = np.inf
    return terms.sum(axis=-1)
