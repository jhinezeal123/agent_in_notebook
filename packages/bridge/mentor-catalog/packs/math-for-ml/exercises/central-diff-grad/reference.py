def numerical_grad(f, x, eps=1e-5):
    x = np.asarray(x, dtype=float)
    work = x.copy()
    grad = np.zeros_like(work, dtype=float)
    it = np.nditer(work, flags=["multi_index"], op_flags=["readwrite"])
    while not it.finished:
        idx = it.multi_index
        orig = work[idx]
        work[idx] = orig + eps
        fp = float(f(work))
        work[idx] = orig - eps
        fm = float(f(work))
        work[idx] = orig
        grad[idx] = (fp - fm) / (2.0 * eps)
        it.iternext()
    return grad


def grad_rel_error(g_analytic, g_numeric, eps=1e-8):
    ga = np.asarray(g_analytic, dtype=float)
    gn = np.asarray(g_numeric, dtype=float)
    num = float(np.linalg.norm(ga - gn))
    den = max(float(np.linalg.norm(ga)) + float(np.linalg.norm(gn)), float(eps))
    return num / den
