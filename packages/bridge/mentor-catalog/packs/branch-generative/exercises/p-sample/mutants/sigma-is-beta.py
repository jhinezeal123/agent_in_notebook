def p_sample(model, x_t, t, sched, noise=None):
    B = x_t.shape[0]
    t_batch = torch.full((B,), t, dtype=torch.long, device=x_t.device)
    eps = model(x_t, t_batch)
    beta = sched["betas"][t]
    alpha = sched["alphas"][t]
    alpha_bar = sched["alpha_bar"][t]
    mean = (x_t - beta / torch.sqrt(1.0 - alpha_bar) * eps) / torch.sqrt(alpha)
    if t == 0:
        return mean
    if noise is None:
        noise = torch.randn_like(x_t)
    return mean + beta * noise
