def make_vit(patch_size, img_size=28):
    if img_size % patch_size != 0:
        raise ValueError(f"img_size = {img_size} phải chia hết cho patch_size = {patch_size}")
    return ViT(img_size, patch_size, 1, 64, 3, 4, 10)


def resize_pos_embed(pos_embed, old_grid, new_grid):
    cls_pe, patch_pe = pos_embed[:, :1], pos_embed[:, 1:]
    dim = pos_embed.shape[-1]
    seq = F.interpolate(patch_pe.transpose(1, 2), size=new_grid * new_grid, mode="linear", align_corners=False)
    patch_pe = seq.transpose(1, 2)
    return torch.cat([cls_pe, patch_pe], dim=1)
