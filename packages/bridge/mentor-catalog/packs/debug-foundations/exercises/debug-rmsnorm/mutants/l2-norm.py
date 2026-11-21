def rms_norm(x, gamma, eps=1e-6):
    x = np.asarray(x, dtype=float)
    ss = (x * x).sum(axis=-1, keepdims=True)
    return gamma * x / np.sqrt(ss + eps)
