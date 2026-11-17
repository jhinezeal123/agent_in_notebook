def euler_sample(model, x0, steps):
    x = x0
    dt = 1.0 / steps
    with torch.no_grad():
        for k in range(steps):
            t = torch.full((x.shape[0],), k / steps, dtype=x.dtype, device=x.device)
            x = x + model(x, t) * dt
    return x
