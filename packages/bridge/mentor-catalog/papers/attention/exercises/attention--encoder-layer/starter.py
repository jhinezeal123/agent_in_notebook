class FeedForward(nn.Module):
    """Eq. 2, §3.3. w1: nn.Linear(d_model, d_ff), w2: nn.Linear(d_ff, d_model).
    forward: x (B, T, d_model) -> (B, T, d_model)."""

    def __init__(self, d_model, d_ff):
        ...

    def forward(self, x):
        ...


class EncoderLayer(nn.Module):
    """Một lớp encoder post-LN (§3.1). Thuộc tính: self_attn (MultiHeadAttention của bạn), ffn (FeedForward),
    norm1, norm2 (nn.LayerNorm(d_model)), drop (nn.Dropout(dropout)).
    forward: x (B, S, d_model), src_mask bool broadcast tới (B, n_heads, S, S), True = được nhìn -> (B, S, d_model)."""

    def __init__(self, d_model, n_heads, d_ff, dropout=0.1):
        ...

    def forward(self, x, src_mask=None):
        ...
