def masked_nll(log_probs, targets, mask):
    log_probs = np.asarray(log_probs, dtype=float)
    mask = np.asarray(mask, float)
    picked = log_probs[:, :, np.asarray(targets)].mean(axis=(-2, -1))
    total = mask.sum()
    if total == 0:
        return 0.0
    return float(-(picked * mask).sum() / total)
