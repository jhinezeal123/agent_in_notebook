def rms_norm(x, gamma, eps=1e-6):
    x = np.asarray(x, dtype=float)
    rms = np.sqrt((x * x).mean(axis=-1, keepdims=True))
    return gamma * x / (rms + eps)
