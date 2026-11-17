class MultiHeadAttention(nn.Module):
    def __init__(self, d_model, n_heads):
        super().__init__()
        if d_model % n_heads:
            raise ValueError("d_model phải chia hết cho n_heads")
        self.n_heads = n_heads
        self.d_k = d_model // n_heads
        self.w_q = nn.Linear(d_model, d_model)
        self.w_k = nn.Linear(d_model, d_model)
        self.w_v = nn.Linear(d_model, d_model)
        self.w_o = nn.Linear(d_model, d_model)

    def _split(self, x):
        B, T, _ = x.shape
        return x.view(B, T, self.d_k, self.n_heads).permute(0, 3, 1, 2)

    def forward(self, q, k, v, mask=None):
        B, Tq, D = q.shape
        q, k, v = self._split(self.w_q(q)), self._split(self.w_k(k)), self._split(self.w_v(v))
        scores = q @ k.transpose(-2, -1) / self.d_k ** 0.5
        if mask is not None:
            scores = scores.masked_fill(~mask, float("-inf"))
        weights = torch.softmax(scores, dim=-1)
        merged = (weights @ v).permute(0, 2, 3, 1).reshape(B, Tq, D)
        return self.w_o(merged)
