class MultiHeadAttention(nn.Module):
    """Multi-head attention (Eq. 1, §3.2.2). w_q, w_k, w_v, w_o: nn.Linear(d_model, d_model).
    forward: q (B, Tq, d_model), k và v (B, Tk, d_model),
    mask bool broadcast được tới (B, n_heads, Tq, Tk), True = được nhìn -> (B, Tq, d_model)."""

    def __init__(self, d_model, n_heads):
        ...

    def forward(self, q, k, v, mask=None):
        ...
