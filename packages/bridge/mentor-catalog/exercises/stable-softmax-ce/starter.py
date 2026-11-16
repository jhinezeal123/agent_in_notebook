def log_softmax(z, axis=-1):
    """log softmax theo trục axis, cùng shape với z, ổn định số."""
    ...


def cross_entropy(logits, targets):
    """logits: (B, C), targets: (B,) int -> trung bình -log softmax(logits)[b, targets[b]]."""
    ...
