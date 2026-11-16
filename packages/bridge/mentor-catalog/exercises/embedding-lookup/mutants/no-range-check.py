def embedding_forward(ids, W):
    return np.asarray(W)[np.asarray(ids)]


def embedding_backward(ids, grad_out, V):
    ids = np.asarray(ids).reshape(-1)
    grad_out = np.asarray(grad_out, dtype=float)
    d = grad_out.shape[-1]
    dW = np.zeros((V, d))
    np.add.at(dW, ids, grad_out.reshape(-1, d))
    return dW
