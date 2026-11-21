def logistic_loss_and_grad(X, y, w, b, lam=0.0):
    X, y, w = np.asarray(X, float), np.asarray(y, float), np.asarray(w, float)
    z = X @ w + b
    loss = float((np.logaddexp(0.0, z) - y * z).mean() + 0.5 * lam * np.dot(w, w))
    p = np.where(z >= 0, 1 / (1 + np.exp(-np.minimum(z, 500))), np.exp(np.maximum(z, -500)) / (1 + np.exp(np.maximum(z, -500))))
    err = (p - y) / len(X)
    return loss, X.T @ err + lam * w, float(err.sum())

def logistic_step(X, y, w, b, lr=0.1, lam=0.0):
    loss, dw, db = logistic_loss_and_grad(X, y, w, b, lam)
    return np.asarray(w, float) + lr * dw, float(b) + lr * db, loss
