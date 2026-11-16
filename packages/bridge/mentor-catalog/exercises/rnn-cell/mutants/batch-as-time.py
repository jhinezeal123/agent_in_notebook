def rnn_step(x_t, h_prev, Wx, Wh, b):
    return np.tanh(x_t @ Wx + h_prev @ Wh + b)


def rnn_forward(x, h0, Wx, Wh, b):
    x = np.asarray(x, dtype=float)
    d_h = Wh.shape[0]
    h = np.zeros((x.shape[0], d_h)) if h0 is None else np.array(h0, dtype=float)
    hs = []
    for x_t in x:
        h = rnn_step(x_t, h, Wx, Wh, b)
        hs.append(h)
    hs = np.stack(hs, axis=1) if hs else np.zeros((0, x.shape[1], d_h))
    return hs, h
