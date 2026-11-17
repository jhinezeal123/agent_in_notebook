def make_vit(patch_size, img_size=28):
    if img_size % patch_size != 0:
        raise ValueError(f"img_size = {img_size} phải chia hết cho patch_size = {patch_size}")
    return ViT(img_size, patch_size, 3, 64, 3, 4, 10)


def resize_pos_embed(pos_embed, old_grid, new_grid):
    cls_pe, patch_pe = pos_embed[:, :1], pos_embed[:, 1:]
    dim = pos_embed.shape[-1]
    grid = patch_pe.reshape(1, old_grid, old_grid, dim).permute(0, 3, 1, 2)
    grid = F.interpolate(grid, size=(new_grid, new_grid), mode="bicubic", align_corners=False)
    patch_pe = grid.permute(0, 2, 3, 1).reshape(1, new_grid * new_grid, dim)
    return torch.cat([cls_pe, patch_pe], dim=1)
