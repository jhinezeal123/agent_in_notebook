def q_sample(x0, t, noise, sched):
    shape = (-1,) + (1,) * (x0.dim() - 1)
    sab = sched["sqrt_alpha_bar"][t].view(shape)
    s1m = sched["sqrt_one_minus_alpha_bar"][t].view(shape)
    return s1m * x0 + sab * noise
