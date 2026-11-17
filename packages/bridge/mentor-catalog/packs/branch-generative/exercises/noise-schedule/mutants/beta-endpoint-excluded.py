def make_schedule(T, beta_start=1e-4, beta_end=0.02):
    betas = beta_start + (beta_end - beta_start) * torch.arange(T, dtype=torch.float32) / T
    alphas = 1.0 - betas
    alpha_bar = torch.cumprod(alphas, dim=0)
    return {
        "betas": betas,
        "alphas": alphas,
        "alpha_bar": alpha_bar,
        "sqrt_alpha_bar": torch.sqrt(alpha_bar),
        "sqrt_one_minus_alpha_bar": torch.sqrt(1.0 - alpha_bar),
    }
