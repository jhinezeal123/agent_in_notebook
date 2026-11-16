def _normal(var, fan_in, fan_out, rng):
    return rng.normal(0.0, np.sqrt(var), size=(fan_in, fan_out))


def _uniform(var, fan_in, fan_out, rng):
    bound = np.sqrt(3.0 * var)
    return rng.uniform(-bound, bound, size=(fan_in, fan_out))


def xavier_normal(fan_in, fan_out, rng):
    return _normal(2.0 / (fan_in + fan_out), fan_in, fan_out, rng)


def xavier_uniform(fan_in, fan_out, rng):
    return _uniform(2.0 / (fan_in + fan_out), fan_in, fan_out, rng)


def kaiming_normal(fan_in, fan_out, rng):
    return _normal(2.0 / fan_in, fan_in, fan_out, rng)


def kaiming_uniform(fan_in, fan_out, rng):
    return _uniform(2.0 / fan_in, fan_in, fan_out, rng)
