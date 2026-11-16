def dropout_forward(x, p, rng, training=True):
    """x: shape bất kỳ -> (out cùng shape x, mask bool cùng shape x; True = giữ). Eval: (x, None)."""
    ...


def dropout_backward(grad_out, mask, p):
    """grad_out, mask: cùng shape (mask có thể là None) -> dL/dx cùng shape grad_out."""
    ...
