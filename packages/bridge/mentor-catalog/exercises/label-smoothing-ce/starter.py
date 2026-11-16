def smoothed_cross_entropy(logits, targets, eps=0.1):
    """logits: (B, C), targets: (B,) int -> trung bình trên batch của -sum_c q[b, c] * log softmax(logits[b])[c],
    với q = (1 - eps) * onehot + eps / C. Ổn định số."""
    ...
