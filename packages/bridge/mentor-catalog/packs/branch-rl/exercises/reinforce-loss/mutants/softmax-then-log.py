def reinforce_loss(logits, actions, returns, baseline=None, normalize=False):
    log_probs = torch.log(F.softmax(logits, dim=-1))
    logp = log_probs.gather(1, actions.unsqueeze(1)).squeeze(1)
    adv = returns.detach()
    if baseline is not None:
        adv = adv - baseline.detach()
    if normalize:
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)
    return -(logp * adv).mean()
