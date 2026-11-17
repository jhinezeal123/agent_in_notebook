def patchify(x, p):
    B, C, H, W = x.shape
    if H % p != 0 or W % p != 0:
        raise ValueError(f"H = {H} và W = {W} phải chia hết cho p = {p}")
    x = x.reshape(B, C, H // p, p, W // p, p)
    x = x.permute(0, 2, 4, 1, 3, 5)
    return x.reshape(B, (H // p) * (W // p), C * p * p)


class PatchEmbed(nn.Module):
    def __init__(self, in_ch, embed_dim, patch_size):
        super().__init__()
        self.patch_size = patch_size
        self.proj = nn.Conv2d(in_ch, embed_dim, kernel_size=patch_size, stride=patch_size)

    def forward(self, x):
        H, W = x.shape[-2:]
        return self.proj(x).flatten(2).transpose(1, 2)
