Ráp một **Vision Transformer** thu nhỏ (Dosovitskiy et al., 2020) từ các mảnh đã có: patch embedding, token `cls`, positional embedding, một chồng khối encoder, LayerNorm cuối và đầu phân loại. Bài `patch-embed` của bạn đã định nghĩa `PatchEmbed` ở phía trên: **dùng lại** nó, không viết lại. Bạn viết hai class: `Block` (một khối encoder) và `ViT` (cả mô hình). Ở bài này được dùng `nn.MultiheadAttention`, `nn.LayerNorm`, `nn.Linear`, `nn.GELU` có sẵn (không dùng `nn.TransformerEncoder`): trọng tâm là **cách ráp**.

**`class Block(nn.Module)`**, khởi tạo `Block(dim, heads, mlp_ratio=4)`, là khối **pre-LN** (LayerNorm đứng *trước* mỗi nhánh con, nhánh con được **cộng** vào đường residual):

$$x \leftarrow x + \operatorname{Attn}\big(\operatorname{LN}_1(x)\big), \qquad x \leftarrow x + \operatorname{MLP}\big(\operatorname{LN}_2(x)\big)$$

| thuộc tính | là gì |
|---|---|
| `ln1`, `ln2` | `nn.LayerNorm(dim)` |
| `attn` | `nn.MultiheadAttention(dim, heads, batch_first=True)`, dùng làm **self-attention** (query, key, value đều là đầu ra của `ln1`); lấy phần tử đầu của kết quả trả về, không cần ma trận trọng số attention |
| `mlp` | một `nn.Sequential` gồm đúng ba lớp: `nn.Linear(dim, mlp_ratio * dim)`, `nn.GELU()`, `nn.Linear(mlp_ratio * dim, dim)` |

`forward(x)`: `x` shape `(B, T, dim)`, trả về cùng shape. Không có mask (mọi token nhìn thấy mọi token).

**`class ViT(nn.Module)`**, khởi tạo `ViT(img_size, patch_size, in_ch, dim, depth, heads, num_classes, mlp_ratio=4)` với ảnh vuông `img_size × img_size`; gọi $N = (\text{img\_size} / \text{patch\_size})^2$.

| thuộc tính | là gì |
|---|---|
| `patch_embed` | `PatchEmbed(in_ch, dim, patch_size)` (của bạn, bài `patch-embed`) |
| `cls_token` | `nn.Parameter` shape `(1, 1, dim)`, token học được đại diện cho cả ảnh |
| `pos_embed` | `nn.Parameter` shape `(1, N + 1, dim)`, positional embedding **học được** cho cả `cls` và $N$ patch |
| `blocks` | `depth` khối `Block(dim, heads, mlp_ratio)` trong một `nn.ModuleList` (hoặc `nn.Sequential`) |
| `norm` | `nn.LayerNorm(dim)`: LayerNorm cuối, sau khối cuối cùng |
| `head` | `nn.Linear(dim, num_classes)` |

Khởi tạo `cls_token` và `pos_embed` ngẫu nhiên nhỏ (như `0.02 * torch.randn(...)`). Không có tham số hay buffer nào khác, không cần dropout.

**`forward(x)`**: `x` shape `(B, in_ch, img_size, img_size)`, trả về **logits** shape `(B, num_classes)`. Các bước theo thứ tự:

1. Ảnh thành $N$ token `(B, N, dim)`.
2. Ghép token `cls` thành token **đầu tiên** của chuỗi: `(B, N + 1, dim)` (`cls_token` chỉ có batch 1, phải nhân ra cho cả batch).
3. Cộng `pos_embed` (sau khi đã ghép: chuỗi có $N + 1$ vị trí).
4. Cho chuỗi đi qua `blocks`, rồi `norm`.
5. Đọc kết quả từ token `cls` (token số 0) rồi đưa qua `head`. **Không** lấy trung bình các token.

Trước khi code, tự trả lời: nếu `depth = 0` (không có khối nào) thì logits của hai ảnh khác nhau có khác nhau không, và vì sao?
