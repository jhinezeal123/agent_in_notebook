torch.manual_seed(0)
device = "cuda" if torch.cuda.is_available() else "cpu"
T, STEPS, BATCH, LR = 200, 4000, 128, 1e-3

sched = {k: v.to(device) for k, v in make_schedule(T, 5e-4, 0.1).items()}
data = load_mnist(20000).to(device)
model = TinyUNet().to(device)
optimizer = torch.optim.Adam(model.parameters(), lr=LR)
