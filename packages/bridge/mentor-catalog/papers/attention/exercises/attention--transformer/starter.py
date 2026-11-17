class Transformer(nn.Module):
    """Transformer encoder-decoder (§3). Thuộc tính: embed (PositionalEmbedding, dùng chung cho src và tgt_in),
    drop (nn.Dropout), enc_layers và dec_layers (nn.ModuleList), out (nn.Linear(d_model, vocab_size, bias=False),
    out.weight chính là embed.embed.weight).
    forward: src (B, S), tgt_in (B, T) int64 -> logits (B, T, vocab_size). Mask lấy từ make_masks(src, tgt_in) (cho sẵn)."""

    def __init__(self, vocab_size, d_model=64, n_heads=4, d_ff=128, n_layers=2, dropout=0.1, max_len=64):
        ...

    def forward(self, src, tgt_in):
        ...
