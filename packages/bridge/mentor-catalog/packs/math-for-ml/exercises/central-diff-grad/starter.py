def numerical_grad(f, x, eps=1e-5):
    """Tính gradient xấp xỉ bằng sai phân trung tâm cho f(x) -> float, mọi shape x."""
    raise NotImplementedError


def grad_rel_error(g_analytic, g_numeric, eps=1e-8):
    """Sai số tương đối L2: ||ga - gn||_2 / max(||ga||_2 + ||gn||_2, eps)."""
    raise NotImplementedError
