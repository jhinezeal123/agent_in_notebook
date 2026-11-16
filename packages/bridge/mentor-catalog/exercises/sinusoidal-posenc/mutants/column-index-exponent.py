def positional_encoding(T, d, base=10000.0):
    if d % 2:
        raise ValueError("d lẻ")
    pos = np.arange(T)[:, None]
    angle = pos / base ** (np.arange(d)[None, :] / d)
    pe = np.sin(angle)
    pe[:, 1::2] = np.cos(angle[:, 1::2])
    return pe
