def euler_sample(model, x0, steps):
    x = x0
    dt = 1.0 / steps
    with torch.no_grad():
        for k in range(steps):
            x = x + model(x, k / steps) * dt
    return x
