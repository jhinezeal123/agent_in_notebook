def embedding_forward(ids, W):
    ids = np.asarray(ids)
    W = np.asarray(W)
    if ids.size and (ids.min() < 0 or ids.max() >= W.shape[0]):
        raise IndexError("id nằm ngoài [0, V)")
    return W[ids]


def embedding_backward(ids, grad_out, V):
    ids = np.asarray(ids)
    grad_out = np.asarray(grad_out, dtype=float)
    d = grad_out.shape[-1]
    dW = np.zeros((V, d))
    np.add.at(dW, ids.reshape(-1), grad_out.reshape(-1, d))
    return dW
