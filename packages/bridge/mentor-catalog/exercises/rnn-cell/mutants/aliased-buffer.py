def rnn_step(x_t, h_prev, Wx, Wh, b):
    return np.tanh(x_t @ Wx + h_prev @ Wh + b)


def rnn_forward(x, h0, Wx, Wh, b):
    x = np.asarray(x, dtype=float)
    B, T, _ = x.shape
    h = np.zeros((B, Wh.shape[0])) if h0 is None else np.array(h0, dtype=float)
    hs = []
    for t in range(T):
        h[:] = rnn_step(x[:, t], h, Wx, Wh, b)
        hs.append(h)
    hs = np.stack(hs, axis=1) if hs else np.zeros((B, 0, Wh.shape[0]))
    return hs, h
