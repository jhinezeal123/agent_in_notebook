def xavier_normal(fan_in, fan_out, rng):
    """-> W: (fan_in, fan_out), N(0, σ²) với Var = 2 / (fan_in + fan_out)."""
    ...


def xavier_uniform(fan_in, fan_out, rng):
    """-> W: (fan_in, fan_out), U(-a, a) với cùng phương sai như xavier_normal."""
    ...


def kaiming_normal(fan_in, fan_out, rng):
    """-> W: (fan_in, fan_out), N(0, σ²) với Var = 2 / fan_in."""
    ...


def kaiming_uniform(fan_in, fan_out, rng):
    """-> W: (fan_in, fan_out), U(-a, a) với cùng phương sai như kaiming_normal."""
    ...
