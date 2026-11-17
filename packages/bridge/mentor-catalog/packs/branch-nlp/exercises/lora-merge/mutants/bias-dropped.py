def merge(lora):
    base = lora.base
    merged = nn.Linear(base.in_features, base.out_features, bias=False)
    with torch.no_grad():
        merged.weight.copy_(base.weight + lora.scale * lora.B @ lora.A)
    for p in merged.parameters():
        p.requires_grad_(False)
    return merged
