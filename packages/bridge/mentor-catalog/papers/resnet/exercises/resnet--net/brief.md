Ráp **ResNet kiểu CIFAR** của paper (He et al., 2015, §4.2) từ khối residual bạn đã làm: `class ResNetCifar(nn.Module)`, khởi tạo `ResNetCifar(n, shortcut=True, num_classes=10)`. Bài `residual-block` của bạn đã định nghĩa `ResidualBlock(in_ch, out_ch, stride=1)` ở phía trên: **dùng lại** nó, không viết lại. Phần cho sẵn của paper có thêm `PlainBlock(in_ch, out_ch, stride=1)`: cùng khối ấy nhưng **bỏ đường tắt** (không phép cộng với $x$, không projection), để dựng mạng "plain" làm đối chứng.

Kiến trúc của paper cho ảnh $32 \times 32$ (không đọc tên "ResNet-20" như một khối đen: nó chỉ là $n = 3$):

1. một conv $3\times3$ ra 16 kênh (rồi BN và ReLU);
2. ba **stage**, mỗi stage là $n$ khối, làm việc ở độ phân giải $32, 16, 8$ với số kênh $16, 32, 64$. Stage 2 và 3 **giảm độ phân giải bằng stride 2** ở khối đầu tiên của stage (khối đó đồng thời đổi số kênh); mọi khối khác dùng stride 1;
3. average pooling toàn cục (trung bình trên cả hai chiều không gian), rồi một lớp `nn.Linear(64, num_classes)`.

Mỗi khối có hai conv $3\times3$, nên tổng số lớp có trọng số là $1 + 2 \cdot 3n + 1 = 6n + 2$ ($n = 3$ cho 20 lớp: ResNet-20). Các conv $1\times1$ của đường tắt projection không được tính vào độ sâu, như paper.

Máy chấm chép trọng số theo tên tham số, nên giữ đúng các thuộc tính sau (nhớ gọi `super().__init__()` trước):

| thuộc tính | là gì |
|---|---|
| `conv1` | `nn.Conv2d(3, 16, ...)` kernel 3×3, `stride=1`, `padding=1`, không bias |
| `bn1` | `nn.BatchNorm2d(16)` |
| `layer1`, `layer2`, `layer3` | mỗi cái một `nn.Sequential` gồm đúng $n$ khối, theo thứ tự stage 1, 2, 3 |
| `fc` | `nn.Linear(64, num_classes)` |

`forward(x)`: `x` shape `(B, 3, H, W)` (thí nghiệm dùng $H = W = 32$, nhưng pooling toàn cục nên kích thước khác vẫn chạy), trả về **logits** shape `(B, num_classes)`. Thứ tự: `conv1`, `bn1`, ReLU, ba stage, pooling toàn cục, `fc`.

**Công tắc `shortcut`:** `shortcut=True` dựng cả mạng bằng `ResidualBlock` của bạn; `shortcut=False` dựng **đúng cùng cấu trúc** (cùng số stage, số khối, số kênh, vị trí stride) bằng `PlainBlock`. Hai mạng chỉ khác nhau ở đường tắt.

Ghi chú về paper: với CIFAR-10, paper dùng đường tắt đồng nhất ở mọi nơi (option A: ở hai chỗ đổi shape, đệm số 0 vào kênh và lấy mẫu bớt, không có tham số). Bản của ta dùng projection $1\times1$ của `ResidualBlock` ở hai chỗ đó (option B): thêm khoảng ba nghìn tham số, không đổi gì về ý tưởng.

Trước khi code, tự trả lời: $n = 5$ thì mạng bao nhiêu lớp? Ảnh $32 \times 32$ đi qua stage 3 còn bao nhiêu điểm ảnh mỗi kênh, và tại sao một mạng $6n+2$ lớp mà chỉ có ba stage?
