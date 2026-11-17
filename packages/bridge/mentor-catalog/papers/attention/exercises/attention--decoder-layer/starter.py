class DecoderLayer(nn.Module):
    """Một lớp decoder post-LN (§3.1): masked self-attention, cross-attention, FFN.
    Thuộc tính: self_attn, cross_attn (hai MultiHeadAttention của bạn), ffn (FeedForward của bạn),
    norm1, norm2, norm3 (nn.LayerNorm(d_model)), drop (nn.Dropout(dropout)).
    forward: x (B, T, d_model), memory (B, S, d_model),
    tgt_mask bool broadcast tới (B, n_heads, T, T), memory_mask bool broadcast tới (B, n_heads, T, S),
    True = được nhìn -> (B, T, d_model)."""

    def __init__(self, d_model, n_heads, d_ff, dropout=0.1):
        ...

    def forward(self, x, memory, tgt_mask=None, memory_mask=None):
        ...
