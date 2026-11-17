def p_sample(model, x_t, t, sched, noise=None):
    eps = model(x_t, torch.tensor(t))
    beta = sched["betas"][t]
    alpha = sched["alphas"][t]
    alpha_bar = sched["alpha_bar"][t]
    mean = (x_t - beta / torch.sqrt(1.0 - alpha_bar) * eps) / torch.sqrt(alpha)
    if t == 0:
        return mean
    if noise is None:
        noise = torch.randn_like(x_t)
    return mean + torch.sqrt(beta) * noise
