def embedding_forward(ids, W):
    ids = np.asarray(ids)
    if ids.size and (ids.min() < 0 or ids.max() >= W.shape[0]):
        raise IndexError("id ngoài khoảng")
    return W[ids]


def embedding_backward(ids, grad_out, V):
    ids = np.asarray(ids).reshape(-1)
    grad_out = np.asarray(grad_out, dtype=float)
    d = grad_out.shape[-1]
    dW = np.zeros((V, d))
    np.add.at(dW, ids, grad_out.reshape(-1, d))
    counts = np.bincount(ids, minlength=V)
    return dW / np.maximum(counts, 1)[:, None]
