def init_params(D, H, C, rng):
    return {"W1": rng.normal(scale=np.sqrt(2 / D), size=(D, H)), "b1": np.zeros(H),
            "W2": rng.normal(scale=np.sqrt(2 / H), size=(H, C)), "b2": np.zeros(C)}


def forward(params, X):
    z1 = X @ params["W1"] + params["b1"]
    h = np.maximum(z1, 0)
    logits = h @ params["W2"] + params["b2"]
    return logits, (X, z1, h)


def loss_and_grads(params, X, y):
    logits, (X, z1, h) = forward(params, X)
    B = len(y)
    shifted = logits - logits.max(axis=1, keepdims=True)
    probs = np.exp(shifted) / np.exp(shifted).sum(axis=1, keepdims=True)
    loss = -np.log(probs[np.arange(B), y]).mean()
    dlogits = probs.copy()
    dlogits[np.arange(B), y] -= 1
    dW2 = h.T @ dlogits
    db2 = dlogits.sum(axis=0)
    dz1 = (dlogits @ params["W2"].T) * (z1 > 0)
    dW1 = X.T @ dz1
    db1 = dz1.sum(axis=0)
    return loss, {"W1": dW1, "b1": db1, "W2": dW2, "b2": db2}


def train(X, y, hidden=32, lr=0.1, epochs=60, batch=32, seed=0):
    rng = np.random.default_rng(seed)
    params = init_params(X.shape[1], hidden, int(y.max()) + 1, rng)
    losses = []
    for epoch in range(epochs):
        order = rng.permutation(len(X))
        X = X[order]
        total = 0.0
        for start in range(0, len(X), batch):
            xb, yb = X[start:start + batch], y[start:start + batch]
            loss, grads = loss_and_grads(params, xb, yb)
            for k in params:
                params[k] += lr * grads[k]
            total += loss * len(yb)
        losses.append(total / len(X))
    return params, losses


def predict(params, X):
    logits, _ = forward(params, X)
    return logits.argmax(axis=1)
