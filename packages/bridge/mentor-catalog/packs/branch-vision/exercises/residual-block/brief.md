Viết **khối residual cơ bản** (basic block) của **ResNet** (He et al., 2015, *Deep Residual Learning for Image Recognition*): `class ResidualBlock(nn.Module)`, khởi tạo `ResidualBlock(in_ch, out_ch, stride=1)`. Một khối học độ lệch $F(x)$ rồi **cộng** vào đường tắt (shortcut) $S(x)$, thay vì học thẳng ánh xạ cần tìm:

$$y = \operatorname{ReLU}\big(F(x) + S(x)\big), \qquad F(x) = \operatorname{BN}_2\Big(\operatorname{conv}_2\big(\operatorname{ReLU}(\operatorname{BN}_1(\operatorname{conv}_1(x)))\big)\Big)$$

Đầu vào `x` shape `(B, in_ch, H, W)`; đầu ra `(B, out_ch, H', W')` với `H' = ⌈H / stride⌉` (cùng cho `W'`). Máy chấm chép trọng số theo tên tham số, nên giữ đúng các thuộc tính sau (nhớ gọi `super().__init__()` trước):

| thuộc tính | là gì |
|---|---|
| `conv1` | `nn.Conv2d(in_ch, out_ch, ...)` kernel 3×3, `padding=1`, **`stride=stride`**, không bias |
| `bn1` | `nn.BatchNorm2d(out_ch)` |
| `conv2` | `nn.Conv2d(out_ch, out_ch, ...)` kernel 3×3, `padding=1`, `stride=1`, không bias |
| `bn2` | `nn.BatchNorm2d(out_ch)` |
| `shortcut` | xem dưới |

**Đường tắt $S$** phụ thuộc vào hai nhánh có cùng shape hay không:

- Nếu `in_ch == out_ch` **và** `stride == 1`: shape của $x$ đã khớp với $F(x)$, nên `shortcut` là phép **đồng nhất**: `nn.Identity()` (không có tham số nào).
- Ngược lại (đổi số kênh hoặc giảm độ phân giải): `shortcut` là một **projection** `nn.Sequential` gồm đúng hai lớp theo thứ tự: một `nn.Conv2d(in_ch, out_ch, kernel_size=1, stride=stride, bias=False)` rồi một `nn.BatchNorm2d(out_ch)`. Kernel 1×1 không có padding.

Ràng buộc:

- ReLU không có tham số: dùng `F.relu` (hoặc `nn.ReLU`, không có thuộc tính nào cho nó trong bảng).
- Hai lớp conv không có bias (Batch Norm đứng ngay sau đã lo phần dịch), và `bn1`, `bn2` là `nn.BatchNorm2d` có sẵn của PyTorch: ở bài này bạn **không** dùng `BatchNorm2d` tự viết ở bài trước, để chỉ tập trung vào cách ráp một khối.
- Phải chạy được với kích thước ảnh lẻ (`H = 7`, `stride = 2`) và với `H ≠ W`.

Trước khi code, tự trả lời: ReLU cuối cùng đứng **trước** hay **sau** phép cộng với đường tắt, và nếu đứng trước thì đầu ra của khối có thể mang giá trị gì mà đầu vào của khối kế tiếp không "thấy" được?
