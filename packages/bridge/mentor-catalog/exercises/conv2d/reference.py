def conv2d(x, w, b, stride=1, padding=0):
    x = np.asarray(x, dtype=float)
    w = np.asarray(w, dtype=float)
    N, C, H, W = x.shape
    F, _, kh, kw = w.shape
    Ho = (H + 2 * padding - kh) // stride + 1
    Wo = (W + 2 * padding - kw) // stride + 1
    xp = np.pad(x, ((0, 0), (0, 0), (padding, padding), (padding, padding)))
    out = np.zeros((N, F, Ho, Wo))
    for u in range(kh):
        for v in range(kw):
            patch = xp[:, :, u:u + stride * Ho:stride, v:v + stride * Wo:stride]
            out += np.einsum("nchw,fc->nfhw", patch, w[:, :, u, v])
    return out + np.asarray(b, dtype=float).reshape(1, F, 1, 1)
