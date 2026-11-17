Ráp **ViT cho thí nghiệm cuối** và học thêm một thủ thuật của paper (Dosovitskiy et al., 2020, §3.1 Eq. 1–4 và §3.2). Bài `vit-forward` của bạn đã định nghĩa `ViT(img_size, patch_size, in_ch, dim, depth, heads, num_classes, mlp_ratio=4)` (và `PatchEmbed` ở bài `patch-embed`): **dùng lại** nó, không viết lại. Bạn viết hai hàm.

**1. `make_vit(patch_size, img_size=28)`** trả về một ViT nhỏ dùng cho chữ số MNIST (ảnh xám 1 kênh, 10 lớp), cấu hình cố định: `dim = 64`, `depth = 3`, `heads = 4`, `mlp_ratio` mặc định (4), `in_ch = 1`, `num_classes = 10`. Chỉ có `patch_size` (và cỡ ảnh) đổi từ thí nghiệm này sang thí nghiệm khác.

Nhắc lại các con số của Eq. 1: ảnh $H \times W$ cắt thành $N = HW / P^2$ patch (với ảnh vuông $N = (H/P)^2$), mỗi patch duỗi thành vector $P^2 C$ chiều rồi chiếu tuyến tính lên $D$ chiều; thêm token `cls`, nên chuỗi có $N + 1$ vị trí và `pos_embed` có $N + 1$ hàng. Vì vậy `patch_size` quyết định độ dài chuỗi, kích thước `pos_embed`, và chi phí của attention.

- `img_size` không chia hết cho `patch_size` thì `raise ValueError` ngay khi gọi `make_vit` (lỗi sớm, rõ ràng, không đợi đến lúc forward).

**2. `resize_pos_embed(pos_embed, old_grid, new_grid)`**: paper nói (§3.2): khi fine-tune ở độ phân giải cao hơn thì giữ patch size và chuỗi dài ra, nên positional embedding đã học "có thể không còn ý nghĩa", và paper "làm **nội suy 2D** positional embedding đã huấn luyện theo vị trí của chúng trong ảnh gốc". Bạn viết phép đó.

- `pos_embed`: tensor shape `(1, 1 + old_grid², D)`, hàng 0 là vị trí của token `cls`, các hàng sau là lưới patch `old_grid × old_grid` quét như đọc chữ (hàng trước cột). Trả về tensor shape `(1, 1 + new_grid², D)`.
- Hàng của `cls` **giữ nguyên** (nó không nằm trên lưới ảnh nên không có gì để nội suy). Phần lưới `old_grid × old_grid` được nội suy lên `new_grid × new_grid` **theo hai chiều không gian** bằng `F.interpolate(..., mode="bicubic", align_corners=False)`, sau đó duỗi lại thành chuỗi theo cùng thứ tự quét.
- `F.interpolate` đòi tensor shape `(N, C, H, W)` (kênh ở trục 1). Hãy tự nghĩ `D` đứng ở đâu và lưới ở đâu.
- Không sửa `pos_embed` đầu vào tại chỗ. Lưới có thể nhỏ đi (`new_grid < old_grid`) hoặc lớn lên; `new_grid == old_grid` thì ra lại đúng giá trị cũ.

Trước khi code, tự trả lời: patch size 4 trên ảnh 28×28 cho bao nhiêu token, patch size 7 thì bao nhiêu? Self-attention tốn cỡ $N^2$: patch 4 đắt hơn patch 7 cỡ bao nhiêu lần? Và nếu ảnh to gấp đôi mỗi chiều mà patch giữ nguyên, số token và chi phí attention đổi thế nào?
