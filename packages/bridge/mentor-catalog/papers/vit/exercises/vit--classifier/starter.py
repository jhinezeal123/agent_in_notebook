def make_vit(patch_size, img_size=28):
    """ViT nhỏ cho MNIST: dim 64, depth 3, heads 4, ảnh xám 1 kênh, 10 lớp; dùng ViT của bạn (bài vit-forward).
    Chuỗi có N + 1 token với N = (img_size / patch_size)²; raise ValueError nếu img_size không chia hết cho patch_size."""
    raise NotImplementedError


def resize_pos_embed(pos_embed, old_grid, new_grid):
    """Nội suy 2D positional embedding (paper §3.2). pos_embed (1, 1 + old_grid², D) -> (1, 1 + new_grid², D):
    hàng cls (hàng 0) giữ nguyên, lưới patch old_grid x old_grid nội suy bicubic lên new_grid x new_grid rồi duỗi lại theo thứ tự quét."""
    raise NotImplementedError
