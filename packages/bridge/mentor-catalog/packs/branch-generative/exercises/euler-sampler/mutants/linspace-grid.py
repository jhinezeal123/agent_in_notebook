def euler_sample(model, x0, steps):
    x = x0
    dt = 1.0 / steps
    grid = torch.linspace(0, 1, steps)
    with torch.no_grad():
        for k in range(steps):
            t = grid[k].to(x.dtype).expand(x.shape[0])
            x = x + model(x, t) * dt
    return x
