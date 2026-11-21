def numerical_grad(f, x, eps=1e-5):
    work = np.asarray(x, dtype=float).copy()
    grad = np.zeros_like(work)
    for idx in np.ndindex(work.shape):
        orig = work[idx]
        work[idx] = orig + eps
        fp = float(f(work))
        work[idx] = orig - eps
        fm = float(f(work))
        work[idx] = orig
        grad[idx] = (fp - fm) / eps
    return grad

def grad_rel_error(g_analytic, g_numeric, eps=1e-8):
    ga, gn = np.asarray(g_analytic, float), np.asarray(g_numeric, float)
    return float(np.linalg.norm(ga - gn)) / max(float(np.linalg.norm(ga)) + float(np.linalg.norm(gn)), float(eps))
