def pairwise_sq_dists(x, y):
    """x: (N, D), y: (M, D) -> (N, M); phần tử [i, j] = ||x[i] - y[j]||²."""
    ...


def pick_logprobs(logits, targets):
    """logits: (..., C) float32, targets: (...) int64 -> (...): log-xác suất của lớp đúng."""
    ...


def batched_scores(q, k):
    """q: (B, H, T, d), k: (B, H, S, d) -> (B, H, T, S): q·k / √d, viết bằng torch.einsum."""
    ...
