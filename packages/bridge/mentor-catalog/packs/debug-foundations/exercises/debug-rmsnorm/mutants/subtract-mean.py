def rms_norm(x, gamma, eps=1e-6):
    x = np.asarray(x, dtype=float)
    x = x - x.mean(axis=-1, keepdims=True)
    ms = (x * x).mean(axis=-1, keepdims=True)
    return gamma * x / np.sqrt(ms + eps)
