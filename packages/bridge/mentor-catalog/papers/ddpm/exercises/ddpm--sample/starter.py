def sample(model, sched, shape, generator=None):
    """Alg. 2 của DDPM (chỉ số bước từ 0): từ x_T ~ N(0, I) đi ngược T bước về x_0.
    model(x_t, t_batch) -> (B, C, H, W); sched: dict từ make_schedule (tensor shape (T,)); shape: (B, C, H, W);
    generator: None hoặc torch.Generator CPU, lấy nhiễu theo thứ tự x_T trước, rồi z của t = T-1, T-2, ...
    Dùng p_sample của bài trước; eval và không gradient; trả model về chế độ cũ. Trả về x_0: (B, C, H, W) float32, không clamp."""
    raise NotImplementedError
