def rms_norm(x, gamma, eps=1e-6):
    x = np.asarray(x, dtype=float)
    ms = (x * x).mean()
    return gamma * x / np.sqrt(ms + eps)
