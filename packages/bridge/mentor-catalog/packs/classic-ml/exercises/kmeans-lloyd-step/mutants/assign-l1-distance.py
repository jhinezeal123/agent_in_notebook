def assign_clusters(X, centroids):
    d1 = np.abs(np.asarray(X, float)[:, None, :] - np.asarray(centroids, float)[None, :, :]).sum(axis=-1)
    return d1.argmin(axis=1)

def update_centroids(X, labels, old_centroids):
    X, labels, old = np.asarray(X, float), np.asarray(labels, int), np.asarray(old_centroids, float)
    out = old.copy()
    for k in range(old.shape[0]):
        m = X[labels == k]
        if len(m): out[k] = m.mean(axis=0)
    return out
