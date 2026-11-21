def numerical_grad(f, x, eps=1e-5):
    grad = np.zeros_like(x, dtype=float)
    for idx in np.ndindex(x.shape):
        orig = x[idx]
        x[idx] = orig + eps
        fp = float(f(x))
        x[idx] = orig - eps
        fm = float(f(x))
        grad[idx] = (fp - fm) / (2.0 * eps)
    return grad

def grad_rel_error(g_analytic, g_numeric, eps=1e-8):
    ga, gn = np.asarray(g_analytic, float), np.asarray(g_numeric, float)
    return float(np.linalg.norm(ga - gn)) / max(float(np.linalg.norm(ga)) + float(np.linalg.norm(gn)), float(eps))
