class Block(nn.Module):
    """Khối Transformer pre-LN. Thuộc tính: ln1, attn (CausalSelfAttention), ln2, mlp (nn.Sequential: Linear, GELU, Linear).
    forward: x (B, T, C) -> (B, T, C)."""

    def __init__(self, n_embd, n_head):
        raise NotImplementedError

    def forward(self, x):
        raise NotImplementedError


class GPT(nn.Module):
    """GPT thu nhỏ. Thuộc tính: block_size, tok_emb, pos_emb, blocks, ln_f, head.
    forward(idx, targets=None): idx (B, T) -> (logits (B, T, vocab_size), loss); loss là None khi không có targets."""

    def __init__(self, vocab_size, block_size, n_embd, n_head, n_layer):
        raise NotImplementedError

    def forward(self, idx, targets=None):
        raise NotImplementedError
