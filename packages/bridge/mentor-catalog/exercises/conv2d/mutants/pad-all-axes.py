def conv2d(x, w, b, stride=1, padding=0):
    N, C, H, W = x.shape
    F, _, kh, kw = w.shape
    xp = np.pad(x, padding)
    Ho = (xp.shape[2] - kh) // stride + 1
    Wo = (xp.shape[3] - kw) // stride + 1
    out = np.zeros((xp.shape[0], F, Ho, Wo))
    for i in range(Ho):
        for j in range(Wo):
            win = xp[:, padding:padding + C, i * stride:i * stride + kh, j * stride:j * stride + kw]
            out[:, :, i, j] = np.tensordot(win, w, axes=([1, 2, 3], [1, 2, 3]))
    return out + b.reshape(1, F, 1, 1)
