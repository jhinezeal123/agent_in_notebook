def shannon_entropy(p):
    p = np.asarray(p, dtype=float)
    pos = p > 0
    terms = np.zeros_like(p, dtype=float)
    terms[pos] = -p[pos] * np.log(p[pos])
    return terms.sum(axis=-1)


def kl_divergence(p, q):
    p = np.asarray(p, dtype=float)
    q = np.asarray(q, dtype=float)
    terms = np.zeros(np.broadcast_shapes(p.shape, q.shape), dtype=float)
    p, q = np.broadcast_arrays(p, q)
    pos_both = (p > 0) & (q > 0)
    pos_zero_q = (p > 0) & (q == 0)
    terms[pos_both] = p[pos_both] * np.log(p[pos_both] / q[pos_both])
    terms[pos_zero_q] = np.inf
    return terms.sum(axis=-1)
