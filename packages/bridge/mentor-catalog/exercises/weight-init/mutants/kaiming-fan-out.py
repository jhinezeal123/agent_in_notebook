def xavier_normal(fan_in, fan_out, rng):
    return rng.normal(0.0, np.sqrt(2.0 / (fan_in + fan_out)), size=(fan_in, fan_out))


def xavier_uniform(fan_in, fan_out, rng):
    a = np.sqrt(6.0 / (fan_in + fan_out))
    return rng.uniform(-a, a, size=(fan_in, fan_out))


def kaiming_normal(fan_in, fan_out, rng):
    return rng.normal(0.0, np.sqrt(2.0 / fan_out), size=(fan_in, fan_out))


def kaiming_uniform(fan_in, fan_out, rng):
    a = np.sqrt(6.0 / fan_out)
    return rng.uniform(-a, a, size=(fan_in, fan_out))
