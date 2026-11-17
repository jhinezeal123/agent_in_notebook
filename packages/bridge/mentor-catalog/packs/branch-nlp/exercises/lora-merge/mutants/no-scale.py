def merge(lora):
    base = lora.base
    merged = nn.Linear(base.in_features, base.out_features, bias=base.bias is not None)
    with torch.no_grad():
        merged.weight.copy_(base.weight + lora.B @ lora.A)
        if base.bias is not None:
            merged.bias.copy_(base.bias)
    for p in merged.parameters():
        p.requires_grad_(False)
    return merged
