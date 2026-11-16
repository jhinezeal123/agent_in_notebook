def conv2d(x, w, b, stride=1, padding=0):
    N, C, H, W = x.shape
    F, _, kh, kw = w.shape
    Ho = (H + 2 * padding - kh + 1) // stride
    Wo = (W + 2 * padding - kw + 1) // stride
    xp = np.pad(x, ((0, 0), (0, 0), (padding, padding), (padding, padding)))
    out = np.zeros((N, F, Ho, Wo))
    for i in range(Ho):
        for j in range(Wo):
            win = xp[:, :, i * stride:i * stride + kh, j * stride:j * stride + kw]
            out[:, :, i, j] = np.tensordot(win, w, axes=([1, 2, 3], [1, 2, 3]))
    return out + b.reshape(1, F, 1, 1)
