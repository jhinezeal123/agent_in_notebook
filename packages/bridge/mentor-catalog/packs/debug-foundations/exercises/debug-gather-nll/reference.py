def masked_nll(log_probs, targets, mask):
    log_probs = np.asarray(log_probs, dtype=float)
    targets = np.asarray(targets)
    mask = np.asarray(mask, dtype=float)
    picked = np.take_along_axis(log_probs, targets[..., None], axis=-1)[..., 0]
    total = mask.sum()
    if total == 0:
        return 0.0
    return float(-(picked * mask).sum() / total)
