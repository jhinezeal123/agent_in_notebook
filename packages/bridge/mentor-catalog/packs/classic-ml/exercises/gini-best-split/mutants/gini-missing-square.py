def gini_impurity(y):
    y = np.asarray(y).ravel()
    if y.size == 0: return 0.0
    _, c = np.unique(y, return_counts=True)
    return float(1.0 - np.sum(c / y.size))

def best_split(X, y):
    return None, None, 0.0
