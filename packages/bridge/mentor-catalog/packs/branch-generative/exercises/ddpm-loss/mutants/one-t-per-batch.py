def ddpm_loss(model, x0, sched, t=None, noise=None):
    B = x0.shape[0]
    T = sched["betas"].shape[0]
    if t is None:
        t = torch.randint(0, T, (1,), device=x0.device).expand(B)
    if noise is None:
        noise = torch.randn_like(x0)
    x_t = q_sample(x0, t, noise, sched)
    pred = model(x_t, t)
    return F.mse_loss(pred, noise)
