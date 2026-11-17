def generate(model, idx, max_new_tokens, temperature=1.0, top_k=None):
    """Sinh thêm max_new_tokens token. idx (B, T0) số nguyên -> (B, T0 + max_new_tokens).
    model(x) -> (logits (B, T, V), loss), x có T <= model.block_size. temperature > 0; top_k: chỉ giữ k logit lớn nhất (None: giữ hết)."""
    raise NotImplementedError
