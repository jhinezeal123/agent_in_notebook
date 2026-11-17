torch.manual_seed(0)
device = "cuda" if torch.cuda.is_available() else "cpu"
D_MODEL, N_HEADS, D_FF, N_LAYERS = 64, 4, 128, 2
STEPS, BATCH, WARMUP = 1500, 128, 400

model = Transformer(VOCAB_SIZE, d_model=D_MODEL, n_heads=N_HEADS, d_ff=D_FF, n_layers=N_LAYERS, dropout=0.1).to(device)
optimizer = torch.optim.Adam(model.parameters(), lr=1.0, betas=(0.9, 0.98), eps=1e-9)
noam = lambda step: 0.5 * D_MODEL ** -0.5 * min((step + 1) ** -0.5, (step + 1) * WARMUP ** -1.5)
scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, noam)

gen = torch.Generator().manual_seed(1)
model.train()
for step in range(STEPS):
    src, tgt_in, tgt_out = (x.to(device) for x in make_batch(BATCH, SEQ_LEN, gen))
    logits = model(src, tgt_out)
    loss = F.cross_entropy(logits.reshape(-1, VOCAB_SIZE), tgt_out.reshape(-1), label_smoothing=0.1)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
    scheduler.step()
