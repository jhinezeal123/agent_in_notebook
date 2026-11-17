def select_ucb(q, n, t, c):
    score = q + c * np.sqrt(np.log(t) / n)
    return int(np.argmax(score))
