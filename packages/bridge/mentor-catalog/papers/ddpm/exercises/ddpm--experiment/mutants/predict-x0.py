torch.manual_seed(0)
device = "cuda" if torch.cuda.is_available() else "cpu"
T, STEPS, BATCH, LR = 200, 4000, 128, 1e-3

sched = {k: v.to(device) for k, v in make_schedule(T, 5e-4, 0.1).items()}
data = load_mnist(20000).to(device)
model = TinyUNet().to(device)
optimizer = torch.optim.Adam(model.parameters(), lr=LR)

gen = torch.Generator().manual_seed(1)
model.train()
for step in range(STEPS):
    x0 = data[torch.randint(0, len(data), (BATCH,), generator=gen).to(device)]
    t = torch.randint(0, T, (BATCH,), device=device)
    noise = torch.randn_like(x0)
    x_t = q_sample(x0, t, noise, sched)
    loss = F.mse_loss(model(x_t, t), x0)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
