Viết hàm `sample(model, sched, shape, generator=None)`: **lấy mẫu một batch ảnh từ nhiễu thuần túy** bằng vòng lặp đầy đủ của **DDPM** (Ho et al., 2020, *Denoising Diffusion Probabilistic Models*, **Alg. 2**). Đây là thành phần ráp của paper mốc: các mảnh khó bạn đã làm ở bài `noise-schedule` và `p-sample`; bài này nối chúng thành thuật toán sinh ảnh, và thí nghiệm cuối sẽ dùng nó để sinh chữ số.

Bài `p-sample` của bạn đã định nghĩa `p_sample(model, x_t, t, sched, noise=None)` (một bước reverse, chỉ số $t$ từ 0, bước $t=0$ không thêm nhiễu): **dùng lại nó**, đừng viết lại công thức. Bạn cũng không cần `make_schedule`: `sched` là dict nó đã trả về (máy chấm dựng nó giúp bạn).

**Thuật toán (Alg. 2 của paper, viết lại với chỉ số từ 0).**

$$x_T\sim\mathcal N(0,\mathbf I);\qquad \text{với } t=T-1,\dots,1,0:\ \ x_{t-1}\leftarrow\text{một bước reverse tại } t;\qquad \text{trả về } x_0$$

(chỉ số từ 0: $T$ là số phần tử của `sched["betas"]`; bước đầu tiên của vòng lặp dùng $t=T-1$, bước cuối dùng $t=0$ và cho ra ảnh sạch.)

**Tham số**

- `model`: một `nn.Module` gọi như `model(x_t, t_batch)` (`t_batch` là `int64` shape `(B,)`), trả về dự đoán nhiễu cùng shape với `x_t`.
- `sched`: dict từ `make_schedule(T)`; các tensor của nó shape `(T,)`, và nằm trên thiết bị nào thì ảnh sinh ra nằm trên thiết bị đó.
- `shape`: tuple `(B, C, H, W)`, shape của batch ảnh cần sinh.
- `generator`: `None` hoặc một `torch.Generator` trên **CPU** để tái lập được. Mọi nhiễu của hàm lấy từ nó theo **đúng thứ tự này** (để máy chấm so từng con số): trước hết $x_T$, rồi nhiễu $z$ của từng bước, từ bước $t=T-1$ trở xuống; mỗi lần là một `torch.randn(shape, generator=generator)` (lấy xong mới chuyển sang thiết bị của `sched`). Truyền $z$ cho `p_sample` qua tham số `noise` của nó; ở bước $t=0$, `p_sample` bỏ qua $z$.

**Trả về:** tensor `float32` shape `shape`, là $x_0$. Không cắt (clamp) giá trị về $[-1,1]$: đó là việc khi hiển thị, không phải của thuật toán.

**Ràng buộc** (đây là những chỗ người ta hay quên khi chuyển thuật toán thành code):

- Sinh ảnh là suy luận: **không tính gradient**, và mô hình ở chế độ **eval** trong lúc sinh; xong thì trả `model` về đúng chế độ (train hay eval) mà nó có lúc gọi hàm.
- Số lần gọi mô hình bằng đúng $T$, mỗi bước một lần.
- Test dùng mô hình giả nhỏ và `T` nhỏ: không cần train gì.

Trước khi code, tự trả lời: $x_T$ lấy từ $\mathcal N(0,\mathbf I)$ có hợp lý không nếu sau $T$ bước thuận ảnh vẫn còn sót một chút tín hiệu? Điều đó đặt yêu cầu gì lên lịch nhiễu? (Xem hình bên phải của Phòng công thức.)
