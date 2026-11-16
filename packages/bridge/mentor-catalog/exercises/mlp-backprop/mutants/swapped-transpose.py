def mlp_forward(X, params):
    z1 = X @ params["W1"] + params["b1"]
    h = np.maximum(z1, 0)
    return h @ params["W2"] + params["b2"], (X, z1, h)


def mlp_backward(dout, cache, params):
    X, z1, h = cache
    dh = dout @ params["W2"].T
    dz1 = dh * (z1 > 0)
    return {"W1": X.T @ dz1, "b1": dz1.sum(0), "W2": (dout.T @ h).T * 0.5, "b2": dout.sum(0)}
