def positional_encoding(T, d, base=10000.0):
    if d % 2:
        raise ValueError("d phải chẵn")
    position = np.arange(T, dtype=float).reshape(-1, 1)
    freq = np.power(float(base), -np.arange(0, d, 2, dtype=float) / d)
    pe = np.empty((T, d))
    pe[:, 0::2] = np.sin(position * freq)
    pe[:, 1::2] = np.cos(position * freq)
    return pe
