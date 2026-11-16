def grads_of(loss_fn, params):
    loss = loss_fn()
    loss.backward()
    return [p.grad for p in params]


def td_loss(q_sa, rewards, q_next, gamma):
    target = rewards + gamma * q_next.max(dim=-1).values
    return ((q_sa - target.detach()) ** 2).mean()


def ema_update(target_params, online_params, tau):
    with torch.no_grad():
        for p_t, p_o in zip(target_params, online_params):
            p_t.mul_(tau).add_(p_o, alpha=1 - tau)
