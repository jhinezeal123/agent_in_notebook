def dropout_forward(x, p, rng, training=True):
    if not 0.0 <= p <= 1.0:
        raise ValueError("p ngoài [0, 1]")
    x = np.asarray(x, dtype=float)
    if not training:
        return x.copy(), None
    if p == 1.0:
        return np.zeros_like(x), np.zeros(x.shape, dtype=bool)
    mask = rng.random(x.shape) >= p
    return np.where(mask, x / (1.0 - p), 0.0), mask


def dropout_backward(grad_out, mask, p):
    grad_out = np.asarray(grad_out, dtype=float)
    if mask is None:
        return grad_out.copy()
    return grad_out * mask
