def adamw_init(params):
    ...


def adamw_step(params, grads, state, lr=1e-3, b1=0.9, b2=0.999, eps=1e-8, wd=1e-2):
    """Trả về (new_params, new_state). Decay lr * wd * theta (theta trước bước) KHÔNG đi qua m, v."""
    ...
