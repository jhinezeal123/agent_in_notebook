torch.manual_seed(0)
device = "cuda" if torch.cuda.is_available() else "cpu"
N_TRAIN, N_EVAL, DEPTH_N, EPOCHS, BATCH, LR = 10000, 2000, 3, 30, 128, 0.1

x_train, y_train = load_cifar10(N_TRAIN, train=True)
x_train, y_train = x_train.to(device), y_train.to(device)
x_test, y_test = load_cifar10(N_EVAL, train=False)


def train(model):
    steps_per_epoch = (len(x_train) + BATCH - 1) // BATCH
    optimizer = torch.optim.SGD(model.parameters(), lr=LR, momentum=0.9, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=LR, total_steps=EPOCHS * steps_per_epoch, pct_start=0.2)
    gen = torch.Generator().manual_seed(1)
    model.train()
    for epoch in range(EPOCHS):
        order = torch.randperm(len(x_train), generator=gen).to(device)
        for i in range(0, len(x_train), BATCH):
            idx = order[i:i + BATCH]
            xb, yb = x_train[idx], y_train[idx]
            flip = torch.rand(len(xb), device=device) < 0.5
            xb = torch.where(flip[:, None, None, None], xb.flip(3), xb)
            loss = F.cross_entropy(model(xb), yb)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            scheduler.step()
        if epoch % 5 == 4:
            print(epoch + 1, float(loss))
    return model


torch.manual_seed(0)
model_res = ResNetCifar(DEPTH_N, shortcut=True).to(device)
torch.manual_seed(0)
model_plain = ResNetCifar(DEPTH_N, shortcut=False).to(device)

for name, m in [("res", model_res), ("plain", model_plain)]:
    print(name, "train", evaluate(m, x_train[:N_EVAL], y_train[:N_EVAL]), "test", evaluate(m, x_test, y_test))
