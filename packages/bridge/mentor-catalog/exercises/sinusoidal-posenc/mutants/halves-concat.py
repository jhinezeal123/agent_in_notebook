def positional_encoding(T, d, base=10000.0):
    if d % 2:
        raise ValueError("d lẻ")
    pos = np.arange(T)[:, None]
    w = 1.0 / base ** (2 * np.arange(d // 2) / d)
    return np.concatenate([np.sin(pos * w), np.cos(pos * w)], axis=1)
