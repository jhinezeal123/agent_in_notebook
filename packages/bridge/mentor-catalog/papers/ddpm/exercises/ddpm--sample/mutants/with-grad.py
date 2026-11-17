def sample(model, sched, shape, generator=None):
    device = sched["betas"].device
    T = sched["betas"].shape[0]
    was_training = model.training
    model.eval()
    x = torch.randn(shape, generator=generator).to(device)
    for t in reversed(range(T)):
        z = torch.randn(shape, generator=generator).to(device)
        x = p_sample(model, x, t, sched, noise=z)
    model.train(was_training)
    return x
