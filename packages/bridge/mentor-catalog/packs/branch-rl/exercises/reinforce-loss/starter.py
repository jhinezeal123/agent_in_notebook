def reinforce_loss(logits, actions, returns, baseline=None, normalize=False):
    """Loss REINFORCE: -mean_t( log pi(a_t | s_t) * A_t ), A_t = returns[t] - baseline[t] (baseline None: A_t = returns[t]).
    normalize=True: A <- (A - A.mean()) / (A.std() + 1e-8). A không nhận gradient.
    logits: (T, A) float32 có gradient; actions: (T,) int64; returns: (T,) float32; baseline: None hoặc (T,) float32.
    Log-xác suất phải ổn định với logits lớn. Trả về tensor vô hướng."""
    raise NotImplementedError
