def ppo_clip_loss(new_logp, old_logp, advantages, clip_eps):
    ratio = torch.exp(new_logp - old_logp)
    adv = advantages.detach()
    unclipped = ratio * adv
    clipped = torch.clamp(ratio, 1.0 - clip_eps, 1.0 + clip_eps) * adv
    return -torch.min(unclipped, clipped).mean()
