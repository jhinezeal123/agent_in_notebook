def conv2d(x, w, b, stride=1, padding=0):
    w = np.asarray(w, dtype=float)[:, :, ::-1, ::-1]
    N, C, H, W = x.shape
    F, _, kh, kw = w.shape
    Ho = (H + 2 * padding - kh) // stride + 1
    Wo = (W + 2 * padding - kw) // stride + 1
    xp = np.pad(x, ((0, 0), (0, 0), (padding, padding), (padding, padding)))
    out = np.zeros((N, F, Ho, Wo))
    for i in range(Ho):
        for j in range(Wo):
            win = xp[:, :, i * stride:i * stride + kh, j * stride:j * stride + kw]
            out[:, :, i, j] = np.einsum("nchw,fchw->nf", win, w)
    return out + b[None, :, None, None]
