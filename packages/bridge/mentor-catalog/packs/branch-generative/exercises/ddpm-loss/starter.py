def ddpm_loss(model, x0, sched, t=None, noise=None):
    """L_simple (Eq. 14 của DDPM): MSE giữa nhiễu thật và nhiễu mô hình đoán.
    model(x_t, t) -> (B, C, H, W); x0: (B, C, H, W); sched: dict từ make_schedule (T = số phần tử của sched["betas"]).
    t: None (tự lấy mỗi ảnh một bước đều trong [0, T-1]) hoặc int64 (B,); noise: None (tự lấy N(0, I)) hoặc (B, C, H, W).
    Dùng lại q_sample của bài trước. Trả về tensor shape ()."""
    raise NotImplementedError
