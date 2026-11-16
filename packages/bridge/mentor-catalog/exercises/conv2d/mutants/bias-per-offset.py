def conv2d(x, w, b, stride=1, padding=0):
    N, C, H, W = x.shape
    F, _, kh, kw = w.shape
    Ho = (H + 2 * padding - kh) // stride + 1
    Wo = (W + 2 * padding - kw) // stride + 1
    xp = np.pad(x, ((0, 0), (0, 0), (padding, padding), (padding, padding)))
    out = np.zeros((N, F, Ho, Wo))
    for u in range(kh):
        for v in range(kw):
            sl = xp[:, :, u:u + stride * Ho:stride, v:v + stride * Wo:stride]
            out += np.einsum("nchw,fc->nfhw", sl, w[:, :, u, v]) + b.reshape(1, F, 1, 1)
    return out
