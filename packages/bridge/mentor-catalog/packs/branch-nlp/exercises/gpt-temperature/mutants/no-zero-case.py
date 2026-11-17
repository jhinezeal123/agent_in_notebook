def temperature_probs(logits, temperature):
    if temperature < 0:
        raise ValueError("temperature phải >= 0")
    return F.softmax(logits / temperature, dim=-1)


def entropy(probs):
    return -torch.xlogy(probs, probs).sum(dim=-1)
