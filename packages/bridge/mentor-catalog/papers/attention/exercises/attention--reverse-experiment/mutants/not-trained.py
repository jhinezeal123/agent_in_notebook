torch.manual_seed(0)
device = "cuda" if torch.cuda.is_available() else "cpu"
D_MODEL, N_HEADS, D_FF, N_LAYERS = 64, 4, 128, 2
STEPS, BATCH, WARMUP = 4000, 128, 400

model = Transformer(VOCAB_SIZE, d_model=D_MODEL, n_heads=N_HEADS, d_ff=D_FF, n_layers=N_LAYERS, dropout=0.1).to(device)
