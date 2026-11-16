def xavier_normal(fan_in, fan_out, rng):
    return np.random.normal(0.0, np.sqrt(2.0 / (fan_in + fan_out)), size=(fan_in, fan_out))


def xavier_uniform(fan_in, fan_out, rng):
    a = np.sqrt(6.0 / (fan_in + fan_out))
    return np.random.uniform(-a, a, size=(fan_in, fan_out))


def kaiming_normal(fan_in, fan_out, rng):
    return np.random.randn(fan_in, fan_out) * np.sqrt(2.0 / fan_in)


def kaiming_uniform(fan_in, fan_out, rng):
    a = np.sqrt(6.0 / fan_in)
    return np.random.uniform(-a, a, size=(fan_in, fan_out))
