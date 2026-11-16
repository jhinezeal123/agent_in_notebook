def positional_encoding(T, d, base=10000.0):
    if d % 2:
        raise ValueError("d lẻ")
    pos = np.arange(T)[:, None]
    i = np.arange(0, d, 2)
    w = 1.0 / base ** (2 * i / d)
    pe = np.zeros((T, d))
    pe[:, 0::2] = np.sin(pos * w)
    pe[:, 1::2] = np.cos(pos * w)
    return pe
