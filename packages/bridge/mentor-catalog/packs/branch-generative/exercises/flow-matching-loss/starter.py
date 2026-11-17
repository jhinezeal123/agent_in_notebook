def fm_loss(model, x1, t=None, x0=None):
    """Conditional flow matching với đường thẳng: t = 0 là nhiễu x0, t = 1 là dữ liệu x1, x_t = (1 - t) x0 + t x1, đích u = x1 - x0.
    model(x_t, t) -> cùng shape x_t, với t: float32 (B,); x1: (B, ...) bất kỳ số chiều sau batch.
    t: None (mỗi mẫu một số đều trong [0, 1)) hoặc (B,); x0: None (tự lấy N(0, I)) hoặc cùng shape x1.
    Trả về MSE trung bình trên mọi phần tử, shape ()."""
    raise NotImplementedError
