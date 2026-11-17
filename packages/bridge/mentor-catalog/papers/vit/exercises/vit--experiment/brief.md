**Thí nghiệm cuối.** Bạn đã có `make_vit(patch_size)` (bài `vit--classifier`, dùng `ViT` của bạn từ bài `vit-forward`). Paper (§3.1, §4.1, §4.5) nhấn mạnh một lựa chọn thiết kế: **patch size**. Patch càng nhỏ thì ảnh thành càng nhiều token $N = (H/P)^2$, mỗi token giữ chi tiết mịn hơn, nhưng chuỗi dài hơn nên mô hình đắt hơn ("tỷ lệ nghịch với bình phương patch size", §4.1): trong bảng kết quả của paper, ViT-B/16 hơn ViT-B/32 vài điểm phần trăm trên ImageNet với chi phí cỡ gấp bốn. Bản thu nhỏ: train **hai ViT nhỏ** (dim 64, 3 khối, 4 head) chỉ khác patch size, trên **20 000 ảnh MNIST**, mỗi cái 8 epoch: dưới một phút cho cả hai trên GPU (khoảng 5 đến 10 phút nếu chỉ có CPU). Rồi đặt cạnh nhau accuracy, số token và chi phí. Cùng ý tưởng, chỉ khác quy mô; và MNIST dễ, nên khoảng cách accuracy giữa hai patch size sẽ **nhỏ**. Đừng cố ép nó: ta báo hai số và nhìn.

**Cần Internet.** Lần chạy đầu, `load_mnist` tải MNIST bằng torchvision (cần bật Internet trong notebook Kaggle; nếu không tải được, nó in cảnh báo và dùng tạm bộ chữ số 8x8 nhỏ của scikit-learn phóng lên 28 × 28: nhòe hơn, chỉ có 1500 ảnh train, nên accuracy thấp hơn và có thể không đạt ngưỡng). GPU không bắt buộc nhưng nhanh hơn nhiều (Kaggle: Settings → Accelerator → GPU T4).

**Cho sẵn** (phần "Cho sẵn của paper", bạn không phải viết): `load_mnist(n, train=True)` trả `(x, y)`: `x` `float32` shape `(n, 1, 28, 28)` đã chuẩn hóa, `y` `int64` shape `(n,)` (nhãn 0 đến 9), lấy `n` ảnh đầu; `evaluate(model, x, y)` trả accuracy ở chế độ eval; `ms_per_image(model, x)` đo thời gian forward (mili giây mỗi ảnh); `show_patch_grid(image, patch_size)` để thấy ảnh bị cắt thành lưới; `plot_curves(curves)` để vẽ các đường theo epoch.

**Việc của bạn: một cell code mà chạy xong thì có hai biến toàn cục:**

| biến | là gì |
|---|---|
| `model_p_small` | ViT với patch size **nhỏ**: `make_vit(4)` (lưới 7 × 7 = 49 token), đã train |
| `model_p_large` | ViT với patch size **lớn**: `make_vit(7)` (lưới 4 × 4 = 16 token), đã train **cùng cách** |

Chú ý tên: `small` và `large` nói về **patch size**, không phải cỡ mô hình (hai mô hình cùng dim, depth, head; số token của patch nhỏ lại *nhiều hơn*). Hai mô hình phải riêng nhau, và train cùng cách (cùng dữ liệu, số epoch, optimizer, learning rate): chỉ patch size khác. Cấu hình gợi ý, đủ để đạt ngưỡng (đổi được, miễn đúng ý):

| mục | giá trị |
|---|---|
| dữ liệu | `load_mnist(20000)` đưa lên thiết bị (`"cuda"` nếu có GPU); mỗi epoch xáo thứ tự rồi duyệt hết, batch 128 |
| loss | `F.cross_entropy(logits, y)` |
| optimizer | AdamW, learning rate lên tới $10^{-3}$ rồi giảm dần về gần 0 theo một lịch (ví dụ `torch.optim.lr_scheduler.OneCycleLR`, gọi `scheduler.step()` sau mỗi bước), weight decay 0,01, 8 epoch |
| chế độ | `model.train()` trong lúc train |
| theo dõi | in loss mỗi vài epoch; sau khi train, in `evaluate` của từng mô hình trên 2000 ảnh test và `ms_per_image` của từng mô hình |

**Máy chấm không train lại cho bạn.** Chạy xong cell train thì bấm **Chấm bài**: máy chấm đọc `model_p_small` và `model_p_large` đang sống trong kernel rồi **tự đo**, không dùng con số bạn in ra:

- `acc_p_small` và `acc_p_large`: accuracy của từng mô hình trên **2000 ảnh đầu của tập test MNIST** (chưa từng thấy), ở chế độ eval. **Mỗi con đạt khi ≥ 0,9** (đoán bừa là 0,1).
- `tokens_p_small` và `tokens_p_large`: số token $N$ của mỗi mô hình (không tính `cls`), đọc từ `pos_embed` của nó. Chỉ báo.
- `ms_p_small` và `ms_p_large`: thời gian forward mỗi ảnh (mili giây) của từng mô hình trên 256 ảnh test, đo bằng `ms_per_image`. Chỉ báo, nhiễu: so tỷ lệ giữa hai số, không so từng số với số của người khác.
- `attn_cost_ratio`: tỷ lệ số phần tử ma trận attention của hai mô hình, $\big((N_\text{small}+1)/(N_\text{large}+1)\big)^2$. Chỉ báo: đặt cạnh tỷ lệ thời gian thực đo được.

Máy chấm cũng kiểm hai mô hình là ViT gọi được trên ảnh `(B, 1, 28, 28)` ra logits `(B, 10)`, hữu hạn (không NaN), **chỉ khác nhau ở patch size** (cùng dim, depth, số head) và mô hình `small` có *nhiều* token hơn mô hình `large`.

Lưu ý: `model_p_small` và `model_p_large` phải là biến toàn cục của kernel khi bấm Chấm bài (đừng đổi tên, đừng chạy lại cell "Code của bạn từ các bài trước" sau khi train: nó định nghĩa lại các lớp). Máy chấm tải lại ảnh bằng `load_mnist`, nên cần Internet (hoặc dữ liệu đã tải sẵn trong `mnist_data`).

Nếu còn thời gian: thử thêm patch 2 (196 token) hoặc patch 14 (4 token), và xem tỷ lệ thời gian đổi theo $N$ thế nào.
