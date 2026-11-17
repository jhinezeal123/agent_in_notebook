Viết hai mảnh đầu tiên của **Vision Transformer** (Dosovitskiy et al., 2020, *An Image is Worth 16x16 Words*): biến một ảnh thành một **chuỗi token** như một câu, để một Transformer đọc được. Bạn viết một hàm `patchify` và một module `PatchEmbed`, rồi (qua test) thấy chúng là **cùng một phép tính** viết hai cách.

**`patchify(x, p)`**: `x` shape `(B, C, H, W)`, `p` là số nguyên (cạnh của patch). Cắt ảnh thành lưới các ô vuông `p × p` **không chồng lấn**, mỗi ô duỗi thành một vector. Trả về shape `(B, N, C·p·p)` với $N = \frac{H}{p}\cdot\frac{W}{p}$.

- **Thứ tự các patch**: quét như đọc chữ, hàng trước cột: patch 0 là ô góc trên-trái, patch 1 là ô ngay bên phải nó, hết hàng đầu thì sang hàng thứ hai.
- **Thứ tự bên trong một patch**: patch là tensor `(C, p, p)` (kênh, hàng, cột); vector của nó là tensor đó duỗi thẳng theo đúng thứ tự `(C, p, p)` (kênh đứng ngoài cùng, rồi hàng, rồi cột), như `patch.reshape(-1)`.
- `H` hoặc `W` không chia hết cho `p` thì `raise ValueError` (không âm thầm cắt bỏ phần dư).
- Chỉ cần `reshape` và `permute` (hoặc `F.unfold`); không cần vòng lặp qua từng patch.

**`PatchEmbed(in_ch, embed_dim, patch_size)`** là `nn.Module` biến ảnh `(B, C, H, W)` thành các token có `embed_dim` chiều, shape `(B, N, embed_dim)`, cùng $N$ và **cùng thứ tự patch** như `patchify`. Giữ đúng tên thuộc tính (máy chấm chép trọng số theo tên):

| thuộc tính | là gì |
|---|---|
| `patch_size` | số nguyên `p` |
| `proj` | **một** `nn.Conv2d(in_ch, embed_dim, kernel_size=p, stride=p)` (có bias, không padding) |

`forward(x)` cho `proj` đi qua ảnh rồi đưa kết quả về dạng `(B, N, embed_dim)`: sau conv, các token đang nằm trên lưới không gian; hãy xử lý lưới đó thành một chuỗi, giữ đúng thứ tự patch ở trên. `H` hoặc `W` không chia hết cho `patch_size` thì cũng `raise ValueError`.

Hai mảnh phải **nhất quán** (test kiểm): với $W$ = `proj.weight` duỗi thành ma trận `(embed_dim, C·p·p)` (`proj.weight.flatten(1)`) và $b$ = `proj.bias`,

$$\operatorname{PatchEmbed}(x) = \operatorname{patchify}(x, p)\,W^\top + b$$

tức là một lớp Linear áp lên từng patch đã duỗi cho ra đúng kết quả của conv stride $p$. Đây là lý do nhiều bản cài đặt ViT dùng conv thay cho "cắt rồi Linear": nhanh hơn, và hai cách chỉ khớp khi thứ tự duỗi trong patch ở `patchify` khớp với cách conv đọc kernel.

Trước khi code, tự trả lời: ảnh 224×224 với patch 16 cho bao nhiêu token, mỗi patch duỗi ra bao nhiêu số (3 kênh)? Patch 8 thì sao, và chi phí của self-attention (tỷ lệ $N^2$) đổi thế nào?
