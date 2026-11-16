def positional_encoding(T, d, base=10000.0):
    if d % 2:
        raise ValueError("d lẻ")
    pos = np.arange(1, T + 1)[:, None]
    w = 1.0 / base ** (np.arange(0, d, 2) / d)
    pe = np.zeros((T, d))
    pe[:, 0::2] = np.sin(pos * w)
    pe[:, 1::2] = np.cos(pos * w)
    return pe
