def _sigmoid_stable(z):
    z = np.asarray(z, dtype=float)
    pos = z >= 0
    out = np.empty_like(z, dtype=float)
    out[pos] = 1.0 / (1.0 + np.exp(-z[pos]))
    ez = np.exp(z[~pos])
    out[~pos] = ez / (1.0 + ez)
    return out


def logistic_loss_and_grad(X, y, w, b, lam=0.0):
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float).ravel()
    w = np.asarray(w, dtype=float)
    N = X.shape[0]
    z = X @ w + float(b)
    bce = np.logaddexp(0.0, z) - y * z
    loss = float(bce.mean() + 0.5 * float(lam) * np.dot(w, w))
    err = (_sigmoid_stable(z) - y) / N
    dw = X.T @ err + float(lam) * w
    db = float(err.sum())
    return loss, dw, db


def logistic_step(X, y, w, b, lr=0.1, lam=0.0):
    w = np.asarray(w, dtype=float)
    loss, dw, db = logistic_loss_and_grad(X, y, w, b, lam=lam)
    return w - float(lr) * dw, float(b) - float(lr) * db, loss
