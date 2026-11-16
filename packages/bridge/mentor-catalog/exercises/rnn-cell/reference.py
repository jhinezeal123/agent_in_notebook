def rnn_step(x_t, h_prev, Wx, Wh, b):
    return np.tanh(np.asarray(x_t, float) @ Wx + np.asarray(h_prev, float) @ Wh + b)


def rnn_forward(x, h0, Wx, Wh, b):
    x = np.asarray(x, dtype=float)
    B, T, _ = x.shape
    d_h = np.shape(Wh)[0]
    h = np.zeros((B, d_h)) if h0 is None else np.array(h0, dtype=float)
    hs = np.zeros((B, T, d_h))
    for t in range(T):
        h = rnn_step(x[:, t], h, Wx, Wh, b)
        hs[:, t] = h
    return hs, h.copy()
