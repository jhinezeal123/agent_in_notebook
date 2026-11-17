def ppo_clip_loss(new_logp, old_logp, advantages, clip_eps):
    ratio = torch.exp(new_logp - old_logp.detach())
    adv = advantages.detach()
    unclipped = ratio * adv
    clipped = torch.clamp(ratio, max=1.0 + clip_eps) * adv
    return -torch.min(unclipped, clipped).mean()
