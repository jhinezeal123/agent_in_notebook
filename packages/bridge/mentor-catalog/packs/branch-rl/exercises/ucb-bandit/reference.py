def select_ucb(q, n, t, c):
    unvisited = np.flatnonzero(n == 0)
    if len(unvisited) > 0:
        return int(unvisited[0])
    score = q + c * np.sqrt(np.log(t) / n)
    return int(np.argmax(score))
