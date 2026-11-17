def q_sample(x0, t, noise, sched):
    sab = sched["sqrt_alpha_bar"][t]
    s1m = sched["sqrt_one_minus_alpha_bar"][t]
    return sab * x0 + s1m * noise
