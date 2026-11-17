def make_schedule(T, beta_start=1e-4, beta_end=0.02):
    """Lịch nhiễu tuyến tính của DDPM, đánh số từ 0 (phần tử i ứng với bước i+1 của paper).
    Trả về dict các tensor float32 shape (T,) với đúng các khoá:
    "betas", "alphas", "alpha_bar", "sqrt_alpha_bar", "sqrt_one_minus_alpha_bar"."""
    raise NotImplementedError
