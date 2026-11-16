class PositionalEmbedding(nn.Module):
    """§3.4–3.5. embed: nn.Embedding(vocab_size, d_model), khởi tạo normal(0, d_model^-1/2);
    buffer pe: (max_len, d_model), sin ở cột chẵn, cos ở cột lẻ.
    forward: tokens (B, T) int64 -> (B, T, d_model) = √d_model · embed(tokens) + pe[:T]."""

    def __init__(self, vocab_size, d_model, max_len=64):
        ...

    def forward(self, tokens):
        ...
