def shannon_entropy(p):
    """Tính Shannon entropy (nats) theo trục cuối; quy ước 0 * log(0) = 0."""
    raise NotImplementedError


def kl_divergence(p, q):
    """Tính D_KL(p || q) (nats) theo trục cuối; trả +inf nếu có p_i > 0 mà q_i == 0."""
    raise NotImplementedError
