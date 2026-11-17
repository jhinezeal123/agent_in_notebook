Viết `reinforce_loss(logits, actions, returns, baseline=None, normalize=False)`: **loss của REINFORCE** (policy gradient) có baseline tùy chọn. Optimizer của PyTorch luôn **giảm** loss, nên ta cần một loss mà gradient của nó đẩy policy về phía "làm nhiều hơn những hành động đã đem lại return cao".

**Ý tưởng.** Với một quỹ đạo gồm $T$ bước, tại mỗi bước policy cho phân phối $\pi_\theta(\cdot\mid s_t)$ trên các hành động và ta đã chọn $a_t$. Hành động nào có return $G_t$ cao hơn mức "bình thường" $b_t$ thì tăng xác suất của nó, thấp hơn thì giảm:

$$A_t = G_t - b_t,\qquad L = -\frac{1}{T}\sum_{t=1}^{T} \log \pi_\theta(a_t \mid s_t)\; A_t$$

- $\log\pi_\theta(a_t\mid s_t)$: log-xác suất mà policy gán cho hành động **đã chọn** ở bước $t$, tính từ `logits` (chưa chuẩn hóa) của bước đó.
- $A_t$ chỉ là **trọng số**, một hằng số với bước tối ưu này: gradient **không** chảy vào `returns` hay `baseline` (`baseline` thường là đầu ra của một mạng giá trị, đang gắn đồ thị tính gradient: loss này không được huấn luyện nó).
- Không có `baseline` (`None`): $A_t = G_t$.
- `normalize=True`: sau khi có $A_t$, chuẩn hóa thành trung bình 0 và độ lệch chuẩn 1 trên cả $T$ bước, $A \leftarrow \dfrac{A - \operatorname{mean}(A)}{\operatorname{std}(A) + 10^{-8}}$, với `std` là độ lệch chuẩn mặc định của PyTorch (`.std()`, chia $T-1$). Chuẩn hóa dùng khi $T \ge 2$.
- Lấy **trung bình theo toàn bộ $T$ bước** (không phải tổng).

**Vào/ra**

- `logits`: `float32`, `(T, A)`, đang gắn gradient (đầu ra của policy). Các bước có thể thuộc nhiều episode khác nhau; hàm không cần biết.
- `actions`: **`int64`**, `(T,)`, hành động đã chọn, giá trị trong `[0, A)`.
- `returns`: `float32`, `(T,)`, return $G_t$ (ví dụ do `returns_to_go` của bạn tính, đổi sang tensor).
- `baseline`: `None`, hoặc `float32` `(T,)` (có thể đang gắn gradient).
- Trả về tensor **vô hướng** (shape `()`, float32), còn gắn với đồ thị của `logits` để gọi `.backward()`.

**Lưu ý**

- `logits` có thể rất lớn (±1000): log-xác suất phải tính ổn định, đừng đi đường vòng qua xác suất rồi mới lấy log.
- Không sửa các tensor vào.
- Bài `returns-to-go` của bạn đã định nghĩa `returns_to_go(rewards, gamma, dones)`: máy chấm dùng lại nó trong một test nối từ thưởng thô tới loss, bạn không phải viết lại.

Máy chấm kiểm: một ví dụ tính tay, **gradient so với công thức giải tích** (đạo hàm của loss theo `logits`), dấu của loss, việc `baseline` và `returns` không nhận gradient, logits rất lớn, chuẩn hóa, khớp lời giải chuẩn trên nhiều shape, và dtype/shape/tác dụng phụ.
