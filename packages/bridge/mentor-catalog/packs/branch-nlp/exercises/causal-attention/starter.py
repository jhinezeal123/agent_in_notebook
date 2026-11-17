class CausalSelfAttention(nn.Module):
    """Causal multi-head self-attention. qkv: nn.Linear(n_embd, 3 * n_embd), proj: nn.Linear(n_embd, n_embd).
    forward: x (B, T, C) -> (B, T, C); vị trí t chỉ nhìn các vị trí 0..t (kể cả chính nó)."""

    def __init__(self, n_embd, n_head):
        raise NotImplementedError

    def forward(self, x):
        raise NotImplementedError
