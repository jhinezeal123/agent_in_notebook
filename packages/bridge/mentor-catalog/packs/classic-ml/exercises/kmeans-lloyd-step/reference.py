def assign_clusters(X, centroids):
    X = np.asarray(X, dtype=float)
    centroids = np.asarray(centroids, dtype=float)
    d2 = ((X[:, None, :] - centroids[None, :, :]) ** 2).sum(axis=-1)
    return d2.argmin(axis=1)


def update_centroids(X, labels, old_centroids):
    X = np.asarray(X, dtype=float)
    labels = np.asarray(labels, dtype=int)
    old = np.asarray(old_centroids, dtype=float)
    out = old.copy()
    for k in range(old.shape[0]):
        members = X[labels == k]
        if len(members) > 0:
            out[k] = members.mean(axis=0)
    return out
