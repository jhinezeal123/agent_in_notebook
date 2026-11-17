class PositionalEmbedding(nn.Module):
    def __init__(self, vocab_size, d_model, max_len=64):
        super().__init__()
        self.d_model = d_model
        self.embed = nn.Embedding(vocab_size, d_model)
        nn.init.normal_(self.embed.weight, mean=0.0, std=d_model ** -0.5)
        position = torch.arange(max_len, dtype=torch.float32).unsqueeze(1)
        freq = torch.pow(10000.0, -torch.arange(0, d_model, dtype=torch.float32) / d_model)
        pe = torch.zeros(max_len, d_model)
        pe[:, 0::2] = torch.sin(position * freq[0::2])
        pe[:, 1::2] = torch.cos(position * freq[1::2])
        self.register_buffer("pe", pe)

    def forward(self, tokens):
        return self.embed(tokens) * self.d_model ** 0.5 + self.pe[: tokens.shape[1]]
