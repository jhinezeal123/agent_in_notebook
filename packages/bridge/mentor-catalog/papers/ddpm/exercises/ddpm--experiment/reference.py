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
    idx = torch.randint(0, len(data), (BATCH,), generator=gen).to(device)
    loss = ddpm_loss(model, data[idx], sched)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
    if step % 500 == 0:
        print(step, float(loss))
