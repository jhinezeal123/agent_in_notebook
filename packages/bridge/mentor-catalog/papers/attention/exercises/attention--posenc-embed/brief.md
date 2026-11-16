Attention không biết thứ tự: hoán vị các token thì đầu ra hoán vị theo, không hơn. Paper bơm thứ tự vào bằng cách **cộng** một vector vị trí cố định vào embedding của mỗi token (§3.5), và nhân embedding với $\sqrt{d_\text{model}}$ trước khi cộng (§3.4: *"In the embedding layers, we multiply those weights by $\sqrt{d_\text{model}}$"*).

Positional encoding hình sin (§3.5), với `pos` là vị trí (đếm **từ 0**) và `i` là chỉ số của **cặp** cột:

$$PE_{(\text{pos},\,2i)} = \sin\!\left(\frac{\text{pos}}{10000^{2i/d_\text{model}}}\right), \qquad PE_{(\text{pos},\,2i+1)} = \cos\!\left(\frac{\text{pos}}{10000^{2i/d_\text{model}}}\right)$$

**`class PositionalEmbedding(nn.Module)`**, khởi tạo `PositionalEmbedding(vocab_size, d_model, max_len=64)` (`d_model` chẵn):

| thuộc tính | là gì |
|---|---|
| `embed` | `nn.Embedding(vocab_size, d_model)`, trọng số khởi tạo **normal, trung bình 0, độ lệch chuẩn $d_\text{model}^{-1/2}$**. Đây là tham số duy nhất của module. |
| `pe` | bảng $PE$ shape `(max_len, d_model)`, đăng ký bằng `self.register_buffer("pe", ...)` (buffer persistent như mặc định: nằm trong `state_dict()`, theo `module.to(...)`, nhưng **không** phải tham số để học). |

Cột chẵn là sin, cột lẻ là cos, **xen kẽ** (cột 0 và cột 1 cùng tần số).

**`forward(tokens)`**: `tokens` shape `(B, T)` kiểu int64, `T ≤ max_len` → shape `(B, T, d_model)`:

$$\text{out}[b, t] = \sqrt{d_\text{model}}\cdot \text{embed}(\text{tokens}[b, t]) + PE[t]$$

Không dropout ở đây (bài sau, `Transformer`, lo việc đó). Paper còn dùng chung một ma trận cho hai embedding và lớp trước softmax; bản này **không** chia sẻ trọng số.

Vì sao khởi tạo như vậy: sau khi nhân $\sqrt{d_\text{model}}$, mỗi thành phần của embedding có độ lệch chuẩn cỡ 1, cùng cỡ với các giá trị sin/cos trong $[-1, 1]$; token và vị trí đều "nghe" được.
