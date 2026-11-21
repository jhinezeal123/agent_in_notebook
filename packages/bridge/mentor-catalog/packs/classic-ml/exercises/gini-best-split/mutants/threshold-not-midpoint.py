def gini_impurity(y):
    y = np.asarray(y).ravel()
    if y.size == 0: return 0.0
    _, c = np.unique(y, return_counts=True)
    return float(1.0 - np.sum((c / y.size) ** 2))

def best_split(X, y):
    X, y = np.asarray(X, float), np.asarray(y).ravel()
    n, d = X.shape
    parent = gini_impurity(y)
    if n < 2 or parent == 0.0: return None, None, 0.0
    bf, bt, bg = None, None, 0.0
    for j in range(d):
        vals = np.unique(X[:, j])
        for thr in vals[:-1]:
            left = X[:, j] <= thr
            nl = int(left.sum())
            gain = parent - (nl * gini_impurity(y[left]) + (n - nl) * gini_impurity(y[~left])) / n
            if gain > bg + 1e-12: bf, bt, bg = j, float(thr), float(gain)
    return bf, bt, float(bg)
