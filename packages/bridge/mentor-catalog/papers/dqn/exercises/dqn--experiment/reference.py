import copy

torch.manual_seed(0)
rng = np.random.default_rng(0)

TOTAL_STEPS = 20000
GAMMA = 0.99
BATCH_SIZE = 64
LEARN_START = 500
SYNC_EVERY = 250
EPS_START, EPS_END, EPS_DECAY = 1.0, 0.05, 5000
EVAL_EVERY, EVAL_EPISODES, EVAL_SEED = 1000, 5, 50_000

env = CartPole()
q_net = QNet()
target_net = QNet()
sync_target(q_net, target_net)
optimizer = torch.optim.Adam(q_net.parameters(), lr=5e-4)
buffer = ReplayBuffer(20000)


def greedy(obs):
    with torch.no_grad():
        return int(q_net(torch.as_tensor(obs, dtype=torch.float32).unsqueeze(0)).argmax())


best_score, best_state = -1.0, copy.deepcopy(q_net.state_dict())

episode_returns = []
episode_return = 0.0
obs = env.reset(seed=0)
for step in range(TOTAL_STEPS):
    eps = epsilon_by_step(step, EPS_START, EPS_END, EPS_DECAY)
    action = select_action(q_net, obs, eps, rng)
    next_obs, reward, done, truncated = env.step(action)
    buffer.push(obs, action, reward, next_obs, done)
    episode_return += reward
    obs = next_obs
    if done or truncated:
        episode_returns.append(episode_return)
        episode_return = 0.0
        obs = env.reset()
    if step >= LEARN_START:
        dqn_train_step(q_net, target_net, optimizer, buffer, BATCH_SIZE, GAMMA, rng)
    if step % SYNC_EVERY == 0:
        sync_target(q_net, target_net)
    if (step + 1) % EVAL_EVERY == 0 and step >= LEARN_START:
        score = evaluate(greedy, EVAL_EPISODES, seed=EVAL_SEED + step)
        if score >= best_score:
            best_score, best_state = score, copy.deepcopy(q_net.state_dict())

q_net.load_state_dict(best_state)
