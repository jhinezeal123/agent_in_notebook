class CausalSelfAttention(nn.Module):
    def __init__(self, n_embd, n_head):
        super().__init__()
        if n_embd % n_head:
            raise ValueError("n_embd phải chia hết cho n_head")
        self.n_head = n_head
        self.qkv = nn.Linear(n_embd, 3 * n_embd)
        self.proj = nn.Linear(n_embd, n_embd)
        self.causal = torch.tril(torch.ones(32, 32, dtype=torch.bool))

    def forward(self, x):
        B, T, C = x.shape
        hd = C // self.n_head
        q, k, v = self.qkv(x).split(C, dim=-1)
        q = q.view(B, T, self.n_head, hd).transpose(1, 2)
        k = k.view(B, T, self.n_head, hd).transpose(1, 2)
        v = v.view(B, T, self.n_head, hd).transpose(1, 2)
        scores = q @ k.transpose(-2, -1) / hd ** 0.5
        scores = scores.masked_fill(~self.causal[:T, :T], float("-inf"))
        weights = torch.softmax(scores, dim=-1)
        y = (weights @ v).transpose(1, 2).reshape(B, T, C)
        return self.proj(y)
