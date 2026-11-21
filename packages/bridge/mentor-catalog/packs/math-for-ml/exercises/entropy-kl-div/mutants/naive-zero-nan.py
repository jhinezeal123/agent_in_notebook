def shannon_entropy(p):
    p = np.asarray(p, dtype=float)
    return -(p * np.log(p)).sum(axis=-1)

def kl_divergence(p, q):
    p, q = np.asarray(p, float), np.asarray(q, float)
    return (p * np.log(p / q)).sum(axis=-1)
