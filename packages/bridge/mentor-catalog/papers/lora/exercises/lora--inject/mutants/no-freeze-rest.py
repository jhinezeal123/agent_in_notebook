def add_lora(model, r, alpha, targets):
    for block in model.blocks:
        for path in targets:
            parent_path, _, name = path.rpartition(".")
            parent = block.get_submodule(parent_path) if parent_path else block
            setattr(parent, name, LoRALinear(getattr(parent, name), r, alpha))
    return model


def count_params(model):
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    return trainable, total
