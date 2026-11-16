def masked_nll(log_probs, targets, mask):
    log_probs = np.asarray(log_probs, dtype=float)
    mask = np.asarray(mask, float)
    picked = np.take_along_axis(log_probs, np.asarray(targets)[..., None], axis=-1)[..., 0]
    total = mask.sum()
    if total == 0:
        return 0.0
    return float((picked * mask).sum() / total)
