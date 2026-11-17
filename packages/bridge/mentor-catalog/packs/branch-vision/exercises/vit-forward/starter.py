class Block(nn.Module):
    """Khối encoder pre-LN. Thuộc tính: ln1, attn (nn.MultiheadAttention, batch_first=True), ln2, mlp (nn.Sequential: Linear, GELU, Linear).
    forward: x (B, T, dim) -> (B, T, dim)."""

    def __init__(self, dim, heads, mlp_ratio=4):
        raise NotImplementedError

    def forward(self, x):
        raise NotImplementedError


class ViT(nn.Module):
    """ViT thu nhỏ. Thuộc tính: patch_embed (PatchEmbed của bạn), cls_token (1, 1, dim), pos_embed (1, N + 1, dim), blocks, norm, head.
    forward: x (B, in_ch, img_size, img_size) -> logits (B, num_classes), đọc từ token cls (token số 0)."""

    def __init__(self, img_size, patch_size, in_ch, dim, depth, heads, num_classes, mlp_ratio=4):
        raise NotImplementedError

    def forward(self, x):
        raise NotImplementedError
