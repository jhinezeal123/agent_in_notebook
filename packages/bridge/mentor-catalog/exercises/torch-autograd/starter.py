def grads_of(loss_fn, params):
    """loss_fn() -> tensor vô hướng; params: list tensor lá -> list gradient cùng shape. Không đổi p.grad."""
    ...


def td_loss(q_sa, rewards, q_next, gamma):
    """q_sa: (B,), rewards: (B,), q_next: (B, A), gamma: float -> tensor vô hướng. Không có gradient vào q_next."""
    ...


def ema_update(target_params, online_params, tau):
    """Hai list tham số cùng shape từng cặp. target <- tau * target + (1 - tau) * online, tại chỗ. Trả về None."""
    ...
