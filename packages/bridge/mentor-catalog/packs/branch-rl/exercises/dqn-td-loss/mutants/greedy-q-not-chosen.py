def dqn_loss(q_net, target_net, batch, gamma):
    states, actions, rewards, next_states, dones = batch
    q_sa = q_net(states).max(dim=1).values
    with torch.no_grad():
        next_q = target_net(next_states).max(dim=1).values
        target = rewards + gamma * (1.0 - dones) * next_q
    return F.smooth_l1_loss(q_sa, target)
