class QNet(nn.Module):
    def __init__(self, obs_dim=4, n_actions=2, hidden=64):
        super().__init__()
        self.fc1 = nn.Linear(obs_dim, hidden)
        self.fc2 = nn.Linear(hidden, hidden)
        self.out = nn.Linear(hidden, n_actions)

    def forward(self, x):
        x = F.relu(self.fc1(x))
        x = F.relu(self.fc2(x))
        return self.out(x)


def epsilon_by_step(step, eps_start, eps_end, decay_steps):
    frac = min(step / (decay_steps + 1), 1.0)
    return eps_start + frac * (eps_end - eps_start)


def select_action(q_net, obs, eps, rng):
    with torch.no_grad():
        q = q_net(torch.as_tensor(obs, dtype=torch.float32).unsqueeze(0))[0]
    if rng.random() < eps:
        return int(rng.integers(q.shape[0]))
    return int(q.argmax())


def sync_target(q_net, target_net, tau=1.0):
    with torch.no_grad():
        for p, p_target in zip(q_net.parameters(), target_net.parameters()):
            p_target.mul_(1.0 - tau).add_(p, alpha=tau)


def dqn_train_step(q_net, target_net, optimizer, buffer, batch_size, gamma, rng):
    if len(buffer) < batch_size:
        return None
    states, actions, rewards, next_states, dones = buffer.sample(batch_size, rng)
    batch = (torch.from_numpy(states), torch.from_numpy(actions), torch.from_numpy(rewards), torch.from_numpy(next_states), torch.from_numpy(dones))
    loss = dqn_loss(q_net, target_net, batch, gamma)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
    return loss.item()
