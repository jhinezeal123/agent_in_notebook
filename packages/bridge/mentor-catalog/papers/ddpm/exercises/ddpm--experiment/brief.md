**Thí nghiệm cuối.** Bạn đã có đủ mảnh của DDPM: lịch nhiễu (`make_schedule`), loss đơn giản (`ddpm_loss`, Eq. 14 / Alg. 1) và vòng lấy mẫu (`sample`, Alg. 2). Giờ **train thật** và đo xem mô hình có học được không. Paper train trên CIFAR-10 (FID 3,17, Bảng 1) với $T = 1000$, U-Net 35,7 triệu tham số, 800 nghìn bước, nhiều ngày trên TPU: không làm nổi ở đây. Bản thu nhỏ: chữ số **MNIST**, $T = 200$, một U-Net 0,7 triệu tham số, 4000 bước, vài phút trên GPU. Cùng thuật toán, chỉ khác quy mô. (Bản thu nhỏ không đo FID; con số để so là loss, và bạn nhìn ảnh mẫu bằng mắt.)

**Cần Internet và GPU.** Lần chạy đầu, `load_mnist` tải MNIST bằng torchvision (cần bật Internet trong notebook Kaggle; nếu không tải được nó in cảnh báo và dùng tạm bộ chữ số 8x8 nhỏ của scikit-learn, nhòe hơn). Train cần **GPU** (Kaggle: Settings → Accelerator → GPU T4): khoảng 4 đến 6 phút. Trên CPU sẽ chậm hàng chục phút, đừng thử.

**Cho sẵn** (phần "Cho sẵn của paper", bạn không phải viết): `IMG_SIZE` (= 32); `load_mnist(n, train=True)` trả `n` ảnh đầu của MNIST thành tensor `float32` shape `(n, 1, 32, 32)`, giá trị trong $[-1, 1]$ (nền đen là $-1$; ảnh 28 × 28 đã thêm viền nền); `TinyUNet(base=32)`, một `nn.Module` gọi như `model(x_t, t)` với `x_t` `(B, 1, 32, 32)` và `t` `int64` `(B,)`, trả dự đoán nhiễu cùng shape (đúng giao diện mà `ddpm_loss` và `sample` của bạn đòi); `show_images(x)` để vẽ lưới ảnh. Bạn không cần đọc bên trong U-Net: đóng vai $\varepsilon_\theta$ của paper là việc của nó.

**Việc của bạn: một cell code mà chạy xong thì có hai biến toàn cục:**

| biến | là gì |
|---|---|
| `sched` | lịch nhiễu từ `make_schedule` của bạn với $T = 200$, `beta_start = 5e-4`, `beta_end = 0.1`, mọi tensor nằm trên cùng thiết bị với mô hình |
| `model` | một `TinyUNet` đã train trên MNIST bằng `ddpm_loss` của bạn |

Về lịch nhiễu: paper dùng $T = 1000$ với $\beta$ từ $10^{-4}$ đến $0{,}02$. Ta chỉ đi $T = 200$ bước nên co giãn $\beta$ lên 5 lần để lịch vẫn kết thúc ở nhiễu thuần túy (xem hình trái của Phòng công thức bài `ddpm--sample`, và máy chấm sẽ kiểm $\bar\alpha_T$). Cấu hình gợi ý, đủ để đạt ngưỡng (đổi được, miễn đúng ý):

| mục | giá trị |
|---|---|
| dữ liệu | `load_mnist(20000)` đưa lên thiết bị; mỗi bước lấy ngẫu nhiên 128 ảnh làm `x0` |
| loss | `ddpm_loss(model, x0, sched)` của bạn (tự lấy $t$ đều và nhiễu): đúng thứ Alg. 1 lấy đạo hàm |
| optimizer | Adam, learning rate $10^{-3}$, 4000 bước, `model.train()` trước vòng lặp |
| thiết bị | `"cuda"` nếu có GPU; `sched`, dữ liệu và `model` cùng thiết bị |
| theo dõi | in loss mỗi 500 bước (nên giảm từ cỡ 1 xuống vài phần trăm); sau khi train, `show_images(sample(model, sched, (16, 1, 32, 32)))` |

**Máy chấm không train lại cho bạn.** Chạy xong cell train thì bấm **Chấm bài**: máy chấm đọc `sched` và `model` đang sống trong kernel rồi **tự đo**, không dùng con số loss bạn in ra:

- `l_simple`: $L_\text{simple}$ trung bình của `model` trên **128 ảnh đầu của tập test MNIST** (mô hình chưa từng thấy), tại 50 bước $t$ cách đều từ 2 đến 198, với nhiễu cố định (seed riêng), ở chế độ eval. **Đạt khi ≤ 0,06.** Để so: đoán $\varepsilon = 0$ cho loss gần 1.
- `l_simple_small_t` và `l_simple_large_t`: cùng phép đo nhưng chỉ trên các $t < 20$ và các $t \ge 100$ (chỉ báo: loss nằm ở đâu theo $t$?).
- `sample_in_range`: máy chấm dùng lời giải chuẩn của `sample` sinh 16 ảnh từ `model` và `sched` của bạn; con số là tỷ lệ pixel nằm trong $[-1{,}5;\ 1{,}5]$ (chỉ báo: ảnh của mô hình hỏng thường phát nổ ra ngoài biên).
- `sample_mean`: giá trị pixel trung bình của 16 ảnh đó (chỉ báo; MNIST thật cỡ $-0{,}8$ vì phần lớn ảnh là nền).

Máy chấm cũng kiểm `sched` đúng lịch của đề (một lịch nhiễu khác đi thì $L_\text{simple}$ không còn so được) và `model` gọi được như `model(x_t, t)`.

Lưu ý: `sched` và `model` phải là biến toàn cục của kernel khi bấm Chấm bài (đừng đổi tên, đừng chạy lại cell "Code của bạn từ các bài trước" sau khi train: nó định nghĩa lại các hàm). Máy chấm tải lại 128 ảnh test MNIST bằng `load_mnist`, nên cần Internet (hoặc dữ liệu đã tải sẵn trong `mnist_data`).
