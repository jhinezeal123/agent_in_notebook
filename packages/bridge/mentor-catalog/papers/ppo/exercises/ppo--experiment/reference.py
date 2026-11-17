torch.manual_seed(0)
generator = torch.Generator().manual_seed(0)

N_ITERS = 50
STEPS_PER_ITER = 1024
GAMMA, LAM = 0.99, 0.95
CLIP_EPS, VF_COEF, ENT_COEF = 0.2, 0.5, 0.01
EPOCHS, MINIBATCH = 4, 64

env = CartPole()
obs = env.reset(seed=0)
policy = ActorCritic()
optimizer = torch.optim.Adam(policy.parameters(), lr=1e-3)

iteration_returns = []
for iteration in range(N_ITERS):
    batch, obs, episode_returns = collect_rollout(env, obs, policy, STEPS_PER_ITER, GAMMA, LAM, generator)
    adv = batch["advantages"]
    batch["advantages"] = (adv - adv.mean()) / (adv.std() + 1e-8)
    ppo_update(policy, optimizer, batch, CLIP_EPS, VF_COEF, ENT_COEF, EPOCHS, MINIBATCH, generator)
    if episode_returns:
        iteration_returns.append(float(np.mean(episode_returns)))
