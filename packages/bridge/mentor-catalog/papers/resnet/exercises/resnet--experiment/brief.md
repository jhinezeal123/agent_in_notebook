**Thí nghiệm cuối.** Bạn đã có `ResNetCifar` (bài `resnet--net`). Paper (§4.2, Hình 6, Bảng 6) train mạng CIFAR-10 sâu 20 đến 1202 lớp, mỗi mạng 164 epoch trên 45 000 ảnh, và thấy hai điều: mạng **plain** (không đường tắt) sâu hơn có lỗi **train** *cao hơn* mạng nông (degradation, không phải overfitting), còn mạng residual thì càng sâu càng tốt; ResNet-20 đạt lỗi test 8,75% (Bảng 6). Bản thu nhỏ ở đây: **ResNet-20 và plain-20** ($n = 3$), mỗi cái train 30 epoch trên **10 000 ảnh** đầu của CIFAR-10, khoảng 4 đến 6 phút cho cả hai trên GPU. Cùng thuật toán, chỉ khác quy mô; và ở độ sâu 20, hiện tượng degradation **yếu và có thể không hiện ra**. Đừng cố ép nó: ta chỉ đặt hai con số cạnh nhau và nhìn bằng mắt thật.

**Cần Internet và GPU.** Lần chạy đầu, `load_cifar10` tải CIFAR-10 từ Hugging Face, vài chục giây (cần bật Internet trong notebook Kaggle; không được thì nó thử máy chủ gốc qua torchvision, có thể rất chậm; nếu vẫn không tải được, nó in cảnh báo và dùng tạm bộ chữ số 8x8 của scikit-learn phóng lên 32 × 32: dễ hơn và rất ít ảnh, nên hai mạng sẽ gần như bằng nhau, hiện tượng của paper gần như biến mất). Train cần **GPU** (Kaggle: Settings → Accelerator → GPU T4). Trên CPU sẽ chậm cả tiếng, đừng thử.

**Cho sẵn** (phần "Cho sẵn của paper", bạn không phải viết): `load_cifar10(n, train=True)` trả `(x, y)`: `x` `float32` shape `(n, 3, 32, 32)` đã chuẩn hóa theo kênh, `y` `int64` shape `(n,)` (nhãn 0 đến 9), lấy `n` ảnh đầu; `PlainBlock` (khối không đường tắt mà `ResNetCifar(..., shortcut=False)` của bạn dùng); `evaluate(model, x, y)` trả `(accuracy, error)` ở chế độ eval (nhớ đưa `x`, `y` lên cùng thiết bị hoặc để nó tự chuyển từng lô); `plot_curves(curves)` để vẽ các đường theo epoch.

**Việc của bạn: một cell code mà chạy xong thì có hai biến toàn cục:**

| biến | là gì |
|---|---|
| `model_res` | `ResNetCifar(3, shortcut=True)` đã train |
| `model_plain` | `ResNetCifar(3, shortcut=False)` đã train **cùng cách** (cùng dữ liệu, cùng số epoch, cùng optimizer và learning rate) |

Hai mô hình phải riêng nhau (hai đối tượng khác nhau), cùng độ sâu; và **chỉ khác nhau ở đường tắt**. Đó là điều làm phép so sánh có nghĩa: nếu bạn train hai mạng khác cách thì chênh lệch không còn là của đường tắt. Cấu hình gợi ý, đủ để đạt ngưỡng (đổi được, miễn đúng ý):

| mục | giá trị |
|---|---|
| dữ liệu | `load_cifar10(10000)` đưa lên thiết bị (`"cuda"` nếu có GPU); mỗi epoch xáo thứ tự rồi duyệt hết, batch 128 |
| loss | `F.cross_entropy(logits, y)` |
| optimizer | SGD, momentum 0,9, weight decay $10^{-4}$, learning rate lên tới 0,1 rồi giảm dần về gần 0 theo một lịch (ví dụ `torch.optim.lr_scheduler.OneCycleLR`, gọi `scheduler.step()` sau mỗi bước), 30 epoch |
| tăng cường dữ liệu (tùy chọn) | lật ngang ngẫu nhiên từng ảnh: thêm vài điểm phần trăm accuracy |
| chế độ | `model.train()` trong lúc train |
| theo dõi | in loss mỗi vài epoch; sau khi train, in `evaluate` của từng mô hình trên tập train và tập test; vẽ bằng `plot_curves` nếu bạn ghi lại theo epoch |

**Máy chấm không train lại cho bạn.** Chạy xong cell train thì bấm **Chấm bài**: máy chấm đọc `model_res` và `model_plain` đang sống trong kernel rồi **tự đo**, không dùng con số bạn in ra:

- `acc_res` và `acc_plain`: accuracy của từng mô hình trên **2000 ảnh đầu của tập test CIFAR-10** (mô hình chưa từng thấy), ở chế độ eval. **`acc_res` đạt khi ≥ 0,5** (đoán bừa là 0,1); `acc_plain` chỉ báo, nhưng nếu dưới 0,25 thì mô hình plain coi như chưa train.
- `train_err_res` và `train_err_plain`: lỗi (tỷ lệ đoán sai) của từng mô hình trên **2000 ảnh đầu của tập train** (nên bạn phải train trên ít nhất những ảnh đó), ở chế độ eval, không tăng cường dữ liệu. Chỉ báo: **không có ngưỡng**, và không có ngưỡng nào đòi plain tệ hơn residual. So hai con số bằng mắt và nói trong phần Bảo vệ bạn thấy gì.
- `depth`: số lớp có trọng số của `model_res` (conv 3×3 và Linear; bạn đặt n = 3 thì là 20).

Máy chấm cũng kiểm hai mô hình gọi được trên ảnh `(B, 3, 32, 32)`, hữu hạn (không NaN), **cùng độ sâu**, và `model_plain` có ít tham số hơn `model_res` (vì không có projection của đường tắt): đó là dấu vết duy nhất nói hai mạng thật sự khác nhau ở đúng chỗ cần khác.

Lưu ý: `model_res` và `model_plain` phải là biến toàn cục của kernel khi bấm Chấm bài (đừng đổi tên, đừng chạy lại cell "Code của bạn từ các bài trước" sau khi train: nó định nghĩa lại các lớp). Máy chấm tải lại ảnh bằng `load_cifar10`, nên cần Internet (hoặc dữ liệu đã tải sẵn từ lần chạy trước).

Nếu còn thời gian: đổi $n = 9$ (56 lớp) cho cả hai mạng. Đó mới là độ sâu mà paper thấy degradation rõ; train lâu gấp ba.
