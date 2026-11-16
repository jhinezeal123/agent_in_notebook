def rnn_step(x_t, h_prev, Wx, Wh, b):
    """x_t: (B, d_in), h_prev: (B, d_h), Wx: (d_in, d_h), Wh: (d_h, d_h), b: (d_h,) -> h_t: (B, d_h)."""
    ...


def rnn_forward(x, h0, Wx, Wh, b):
    """x: (B, T, d_in), h0: (B, d_h) hoặc None -> (hs: (B, T, d_h), h_last: (B, d_h))."""
    ...
