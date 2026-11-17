def merge(lora):
    with torch.no_grad():
        lora.base.weight += lora.scale * lora.B @ lora.A
    return lora.base
