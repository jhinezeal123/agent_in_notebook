def patchify(x, p):
    """x (B, C, H, W) -> (B, N, C*p*p), N = (H/p) * (W/p).
    Patch quét hàng trước cột; mỗi patch duỗi theo thứ tự (C, p, p). H hoặc W không chia hết cho p thì ValueError."""
    raise NotImplementedError


class PatchEmbed(nn.Module):
    """Ảnh -> chuỗi token. Thuộc tính: patch_size, proj (nn.Conv2d(in_ch, embed_dim, kernel_size=p, stride=p)).
    forward: x (B, C, H, W) -> (B, N, embed_dim), cùng thứ tự patch như patchify. H hoặc W không chia hết cho p thì ValueError."""

    def __init__(self, in_ch, embed_dim, patch_size):
        raise NotImplementedError

    def forward(self, x):
        raise NotImplementedError
