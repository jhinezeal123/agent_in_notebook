def temperature_probs(logits, temperature):
    if temperature < 0:
        raise ValueError("temperature phải >= 0")
    if temperature == 0:
        return F.one_hot(logits.argmax(dim=-1), logits.size(-1)).to(logits.dtype)
    return F.softmax(logits / temperature, dim=-1)


def entropy(probs):
    return -torch.xlogy(probs, probs).mean(dim=-1)
