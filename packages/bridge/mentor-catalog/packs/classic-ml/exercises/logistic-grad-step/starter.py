def logistic_loss_and_grad(X, y, w, b, lam=0.0):
    """Trả về (loss, dw, db) ổn định số với mọi biên độ logits z = X @ w + b."""
    raise NotImplementedError


def logistic_step(X, y, w, b, lr=0.1, lam=0.0):
    """Một bước gradient descent; trả về (w_new, b_new, loss) không sửa w tại chỗ."""
    raise NotImplementedError
