def q_sample(x0, t, noise, sched):
    shape = (-1,) + (1,) * (x0.dim() - 1)
    ab = sched["alpha_bar"][t].view(shape)
    return ab * x0 + (1.0 - ab) * noise
