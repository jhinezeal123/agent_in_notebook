def assign_clusters(X, centroids):
    d2 = ((np.asarray(X, float)[:, None, :] - np.asarray(centroids, float)[None, :, :]) ** 2).sum(axis=-1)
    return d2.argmin(axis=1)

def update_centroids(X, labels, old_centroids):
    X, labels = np.asarray(X, float), np.asarray(labels, int)
    for k in range(old_centroids.shape[0]):
        m = X[labels == k]
        if len(m): old_centroids[k] = m.mean(axis=0)
    return old_centroids
