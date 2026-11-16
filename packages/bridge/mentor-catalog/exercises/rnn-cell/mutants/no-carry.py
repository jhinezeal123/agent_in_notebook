def rnn_step(x_t, h_prev, Wx, Wh, b):
    return np.tanh(x_t @ Wx + h_prev @ Wh + b)


def rnn_forward(x, h0, Wx, Wh, b):
    x = np.asarray(x, dtype=float)
    B, T, _ = x.shape
    h0 = np.zeros((B, Wh.shape[0])) if h0 is None else np.asarray(h0, dtype=float)
    hs = np.zeros((B, T, Wh.shape[0]))
    for t in range(T):
        hs[:, t] = rnn_step(x[:, t], h0, Wx, Wh, b)
    h_last = hs[:, -1] if T else h0.copy()
    return hs, h_last
