def embedding_forward(ids, W):
    ids = np.asarray(ids)
    if ids.size and (ids.min() < 0 or ids.max() >= W.shape[0]):
        raise IndexError("id ngoài khoảng")
    return W[ids]


def embedding_backward(ids, grad_out, V):
    ids = np.atleast_2d(np.asarray(ids))
    grad_out = np.asarray(grad_out, dtype=float).reshape(ids.shape + (-1,))
    dW = np.zeros((V, grad_out.shape[-1]))
    for b in range(ids.shape[0]):
        dW[ids[b]] += grad_out[b]
    return dW
