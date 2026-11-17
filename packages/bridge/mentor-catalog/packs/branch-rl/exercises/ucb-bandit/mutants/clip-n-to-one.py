def select_ucb(q, n, t, c):
    score = q + c * np.sqrt(np.log(t) / np.maximum(n, 1))
    return int(np.argmax(score))
