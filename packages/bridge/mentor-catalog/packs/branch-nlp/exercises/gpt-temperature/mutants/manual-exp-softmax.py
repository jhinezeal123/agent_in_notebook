def temperature_probs(logits, temperature):
    if temperature < 0:
        raise ValueError("temperature phải >= 0")
    if temperature == 0:
        return F.one_hot(logits.argmax(dim=-1), logits.size(-1)).to(logits.dtype)
    e = torch.exp(logits / temperature)
    return e / e.sum(dim=-1, keepdim=True)


def entropy(probs):
    return -torch.xlogy(probs, probs).sum(dim=-1)
