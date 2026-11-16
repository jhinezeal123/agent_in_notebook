def masked_nll(log_probs, targets, mask):
    log_probs = np.asarray(log_probs, dtype=float)
    picked = np.take_along_axis(log_probs, np.asarray(targets)[..., None], axis=-1)[..., 0]
    return float(-(picked * np.asarray(mask, float)).sum() / picked.size)
