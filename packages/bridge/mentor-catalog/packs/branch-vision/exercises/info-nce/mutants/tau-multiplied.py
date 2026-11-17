def nt_xent(z1, z2, temperature=0.5):
    n = z1.shape[0]
    z = F.normalize(torch.cat([z1, z2], dim=0), dim=1)
    logits = z @ z.T * temperature
    logits = logits.masked_fill(torch.eye(2 * n, dtype=torch.bool, device=z.device), float("-inf"))
    targets = (torch.arange(2 * n, device=z.device) + n) % (2 * n)
    return F.cross_entropy(logits, targets)
