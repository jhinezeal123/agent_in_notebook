def q_sample(x0, t, noise, sched):
    """Eq. 4 của DDPM: ảnh nhiễu tới bước t (từ 0) trong một lần tính.
    x0: (B, C, H, W) float32; t: (B,) int64, mỗi ảnh một bước; noise: (B, C, H, W) = ε;
    sched: dict từ make_schedule (mỗi tensor shape (T,)). Trả về (B, C, H, W) float32. Không sửa đầu vào."""
    raise NotImplementedError
