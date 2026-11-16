def rnn_step(x_t, h_prev, Wx, Wh, b):
    return np.tanh(x_t @ Wx + h_prev @ Wh.T + b)


def rnn_forward(x, h0, Wx, Wh, b):
    x = np.asarray(x, dtype=float)
    B, T, _ = x.shape
    h = np.zeros((B, Wh.shape[0])) if h0 is None else np.array(h0, dtype=float)
    hs = np.zeros((B, T, Wh.shape[0]))
    for t in range(T):
        h = rnn_step(x[:, t], h, Wx, Wh, b)
        hs[:, t] = h
    return hs, h.copy()
