def assign_clusters(X, centroids):
    d2 = ((np.asarray(X, float)[:, None, :] - np.asarray(centroids, float)[None, :, :]) ** 2).sum(axis=-1)
    return d2.argmin(axis=1)

def update_centroids(X, labels, old_centroids):
    X, labels, old = np.asarray(X, float), np.asarray(labels, int), np.asarray(old_centroids, float)
    return np.array([X[labels == k].mean(axis=0) for k in range(old.shape[0])])
