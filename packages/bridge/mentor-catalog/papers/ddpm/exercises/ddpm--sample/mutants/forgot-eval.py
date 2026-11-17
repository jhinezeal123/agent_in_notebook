@torch.no_grad()
def sample(model, sched, shape, generator=None):
    device = sched["betas"].device
    T = sched["betas"].shape[0]
    x = torch.randn(shape, generator=generator).to(device)
    for t in reversed(range(T)):
        z = torch.randn(shape, generator=generator).to(device)
        x = p_sample(model, x, t, sched, noise=z)
    return x
