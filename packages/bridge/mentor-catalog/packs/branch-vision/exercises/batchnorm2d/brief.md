Viết **Batch Normalization** cho ảnh (Ioffe & Szegedy, 2015) từ đầu, không dùng bản có sẵn của PyTorch: `class BatchNorm2d(nn.Module)`, khởi tạo `BatchNorm2d(num_features, eps=1e-5, momentum=0.1)`. Đầu vào $x$ có shape `(N, C, H, W)` với `C = num_features`; đầu ra cùng shape.

| tên | loại | là gì |
|---|---|---|
| `weight` | `nn.Parameter` `(C,)`, khởi tạo toàn 1 | $\gamma_c$ |
| `bias` | `nn.Parameter` `(C,)`, khởi tạo toàn 0 | $\beta_c$ |
| `running_mean` | **buffer** `(C,)`, khởi tạo toàn 0 | trung bình tích lũy, dùng lúc eval |
| `running_var` | **buffer** `(C,)`, khởi tạo toàn 1 | phương sai tích lũy, dùng lúc eval |
| `num_batches_tracked` | **buffer** số nguyên (`torch.long`) 0 chiều, khởi tạo 0 | đếm số lần forward ở chế độ train |
| `eps`, `momentum` | số Python | đúng hai đối số khởi tạo |

Buffer là tensor đi theo `state_dict()` và `.to(device)` nhưng **không phải tham số** (optimizer không học nó): tạo bằng `self.register_buffer(tên, tensor)`. Máy chấm chép trọng số theo tên trong `state_dict()`, nên giữ đúng các tên ở bảng và nhớ gọi `super().__init__()` trước.

**Chế độ train** (`self.training` là `True`). Với mỗi kênh $c$, gom mọi giá trị của kênh đó trên **cả ba trục** $N, H, W$ (tổng cộng $n = N \cdot H \cdot W$ giá trị mỗi kênh):

$$\mu_c = \frac{1}{n}\sum_{n,h,w} x, \qquad \sigma_c^2 = \frac{1}{n}\sum_{n,h,w} (x - \mu_c)^2, \qquad y = \gamma_c\,\frac{x - \mu_c}{\sqrt{\sigma_c^2 + \varepsilon}} + \beta_c$$

Cùng lúc đó cập nhật các buffer (đây là phần dễ sai nhất của bài), với $m$ là `momentum`:

$$\text{running\_mean} \leftarrow (1 - m)\,\text{running\_mean} + m\,\mu_c, \qquad \text{running\_var} \leftarrow (1 - m)\,\text{running\_var} + m\,s_c^2, \qquad s_c^2 = \frac{n}{n-1}\,\sigma_c^2$$

và `num_batches_tracked` tăng thêm 1. Hai loại phương sai ở trên **khác nhau** (chia $n$ cho việc chuẩn hóa, chia $n-1$ cho running stats): đọc kỹ xem cái nào dùng ở đâu.

**Chế độ eval** (`self.training` là `False`): không dùng thống kê của batch, dùng buffer; không cập nhật gì:

$$y = \gamma_c\,\frac{x - \text{running\_mean}_c}{\sqrt{\text{running\_var}_c + \varepsilon}} + \beta_c$$

Ràng buộc:

- Trục kênh là trục 1. `x` có thể có `H ≠ W`, `N = 1`, hay `H = W = 1`.
- Gradient phải chảy qua $\mu_c$ và $\sigma_c^2$ của batch (chúng phụ thuộc vào $x$), còn các buffer thì **không** nằm trong đồ thị tính gradient.
- Ở chế độ train mà $n = N \cdot H \cdot W = 1$ (mỗi kênh chỉ có một giá trị) thì phương sai không thiên lệch không xác định: `raise ValueError`. Chế độ eval thì vẫn chạy được với $n = 1$.
- Không gọi `F.batch_norm` / `torch.batch_norm`, không bọc hay kế thừa `nn.BatchNorm2d`: máy chấm bắt.
- Không sửa `x` tại chỗ.

Trước khi code, tự trả lời: lúc eval chỉ có **một** ảnh trong batch, thống kê của batch đó dùng được không? Và vì sao running stats lấy phương sai chia $n-1$ trong khi chuẩn hóa lấy chia $n$?
