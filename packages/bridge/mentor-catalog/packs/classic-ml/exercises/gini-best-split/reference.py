def gini_impurity(y):
    y = np.asarray(y).ravel()
    n = y.size
    if n == 0:
        return 0.0
    _, counts = np.unique(y, return_counts=True)
    p = counts / n
    return float(1.0 - np.sum(p * p))


def best_split(X, y):
    X = np.asarray(X, dtype=float)
    y = np.asarray(y).ravel()
    n, d = X.shape
    parent = gini_impurity(y)
    if n < 2 or parent == 0.0:
        return None, None, 0.0
    best_feat, best_thr, best_gain = None, None, 0.0
    for j in range(d):
        col = X[:, j]
        vals = np.unique(col)
        if vals.size < 2:
            continue
        thresholds = 0.5 * (vals[:-1] + vals[1:])
        for thr in thresholds:
            left = col <= thr
            nl = int(left.sum())
            nr = n - nl
            if nl == 0 or nr == 0:
                continue
            gain = parent - (nl * gini_impurity(y[left]) + nr * gini_impurity(y[~left])) / n
            if gain > best_gain + 1e-12:
                best_feat, best_thr, best_gain = j, float(thr), float(gain)
    return best_feat, best_thr, float(best_gain)
