torch.manual_seed(0)
device = "cuda" if torch.cuda.is_available() else "cpu"
N_TRAIN, N_EVAL, EPOCHS, BATCH, LR = 20000, 2000, 8, 128, 1e-3

x_train, y_train = load_mnist(N_TRAIN, train=True)
x_train, y_train = x_train.to(device), y_train.to(device)
x_test, y_test = load_mnist(N_EVAL, train=False)


def train(model):
    steps_per_epoch = (len(x_train) + BATCH - 1) // BATCH
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=0.01)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=LR, total_steps=EPOCHS * steps_per_epoch, pct_start=0.1)
    gen = torch.Generator().manual_seed(1)
    model.train()
    for epoch in range(EPOCHS):
        order = torch.randperm(len(x_train), generator=gen).to(device)
        for i in range(0, len(x_train), BATCH):
            idx = order[i:i + BATCH]
            loss = F.cross_entropy(model(x_train[idx]), y_train[idx])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            scheduler.step()
        print(epoch + 1, float(loss))
    return model


torch.manual_seed(0)
model_p_small = train(make_vit(4).to(device))
torch.manual_seed(0)
model_p_large = train(make_vit(7).to(device))

for name, m in [("p_small", model_p_small), ("p_large", model_p_large)]:
    print(name, "N =", m.pos_embed.shape[1] - 1, "acc", evaluate(m, x_test, y_test), "ms/ảnh", ms_per_image(m, x_test[:256]))
