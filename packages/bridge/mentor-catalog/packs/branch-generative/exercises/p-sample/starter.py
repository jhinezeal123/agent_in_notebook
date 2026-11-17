def p_sample(model, x_t, t, sched, noise=None):
    """Một bước reverse của DDPM (Alg. 2, dòng 3-4), chỉ số bước từ 0, sigma_t^2 = beta_t.
    model(x_t, t_batch) -> (B, C, H, W), t_batch là int64 (B,) toàn giá trị t; x_t: (B, C, H, W) float32;
    t: số nguyên Python trong [0, T-1]; sched: dict từ make_schedule; noise: None (tự lấy N(0, I) khi cần) hoặc z cùng shape x_t.
    t = 0: không thêm nhiễu (bỏ qua noise). Trả về x_{t-1}: (B, C, H, W) float32, không sửa x_t."""
    raise NotImplementedError
