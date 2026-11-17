def ppo_update(policy, optimizer, batch, clip_eps, vf_coef, ent_coef, epochs, minibatch_size, generator, max_grad_norm=0.5):
    n = batch["obs"].shape[0]
    totals = {"loss": 0.0, "clip_fraction": 0.0, "approx_kl": 0.0}
    updates = 0
    for _ in range(epochs):
        for idx in minibatch_indices(n, minibatch_size, generator):
            obs = batch["obs"][idx]
            actions = batch["actions"][idx]
            old_logp = batch["old_logp"][idx]
            logits, value = policy(obs)
            log_probs = F.log_softmax(logits, dim=-1)
            new_logp = log_probs.gather(1, actions.unsqueeze(1)).squeeze(1)
            entropy = -(log_probs.exp() * log_probs).sum(dim=-1).mean()
            pg_loss = ppo_clip_loss(new_logp, old_logp, batch["advantages"][idx], clip_eps)
            value_loss = F.mse_loss(value, batch["returns"][idx].detach())
            loss = pg_loss + vf_coef * value_loss - ent_coef * entropy
            loss.backward()
            if max_grad_norm is not None:
                nn.utils.clip_grad_norm_(policy.parameters(), max_grad_norm)
            optimizer.step()
            with torch.no_grad():
                log_ratio = new_logp.detach() - old_logp.detach()
                totals["loss"] += loss.item()
                totals["clip_fraction"] += ((log_ratio.exp() - 1.0).abs() > clip_eps).float().mean().item()
                totals["approx_kl"] += (-log_ratio).mean().item()
            updates += 1
    return {k: v / max(updates, 1) for k, v in totals.items()}
