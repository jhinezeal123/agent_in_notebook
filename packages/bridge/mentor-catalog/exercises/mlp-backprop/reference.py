def mlp_forward(X, params):
    X = np.asarray(X, dtype=float)
    z1 = X @ params["W1"] + params["b1"]
    h = np.maximum(z1, 0)
    out = h @ params["W2"] + params["b2"]
    return out, (X, z1, h)


def mlp_backward(dout, cache, params):
    X, z1, h = cache
    dW2 = h.T @ dout
    db2 = dout.sum(axis=0)
    dh = dout @ params["W2"].T
    dz1 = dh * (z1 > 0)
    dW1 = X.T @ dz1
    db1 = dz1.sum(axis=0)
    return {"W1": dW1, "b1": db1, "W2": dW2, "b2": db2}
