def rms_norm(x, gamma, eps=1e-6):
    x = np.asarray(x, dtype=float)
    ms = (x * x).mean(axis=-1, keepdims=True)
    return np.asarray(gamma, dtype=float) * x / np.sqrt(ms + eps)
