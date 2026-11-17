**Biến thể của `info-nce`.** Ở bài gốc, temperature $\tau$ là một hằng số bạn chọn tay (SimCLR thử 0.1, 0.5, 1.0). CLIP (Radford et al., 2021) làm khác: **để mô hình tự học $\tau$** cùng với mọi tham số khác. Bài này bạn bọc `nt_xent` của mình trong một module có temperature học được. Trước khi code, hãy trả lời câu dự đoán đi kèm bài.

**`LearnableTemperature(init_tau=0.07)`** là `nn.Module`. Bài `info-nce` của bạn đã định nghĩa `nt_xent`: **dùng lại** nó, không viết lại loss. Ta không học thẳng $\tau$ (phải dương, và nhạy khi nhỏ) mà học **logarit của nghịch đảo** của nó, để tham số tự do trên cả trục số thực và tích $s = 1/\tau$ luôn dương:

| thuộc tính | là gì |
|---|---|
| `log_scale` | `nn.Parameter` **0 chiều** (một số), khởi tạo $\ln(1 / \tau_0)$ với $\tau_0$ = `init_tau` |

Không có tham số hay buffer nào khác (máy chấm chép trọng số theo tên tham số).

**`forward(z1, z2)`**: `z1`, `z2` shape `(N, D)` như ở bài `info-nce`. Tính $s = e^{\text{log\_scale}}$, rồi **chặn trên của $s$ ở 100** (CLIP làm thế để $\tau$ không co về 0 và làm mất ổn định), rồi trả về loss NT-Xent với $\tau = 1/s$:

$$s = \min\big(e^{\text{log\_scale}},\ 100\big), \qquad \text{loss} = \texttt{nt\_xent}\big(z_1, z_2, \ \tau = 1/s\big)$$

- Chặn ngay **trong `forward`**, không sửa giá trị của `log_scale`: tham số giữ nguyên số mà người gọi đặt, chỉ có $s$ dùng trong phép tính bị chặn. Khi $s$ bị chặn (tức $e^{\text{log\_scale}} > 100$) thì loss không còn phụ thuộc `log_scale`, nên gradient theo nó bằng 0.
- Temperature truyền cho `nt_xent` là một **tensor 0 chiều còn trong đồ thị tính gradient** (không chuyển nó thành số Python): `log_scale` phải nhận được gradient từ loss.
- Nếu test báo `log_scale` không nhận gradient mà `forward` của bạn đúng, hãy xem lại `nt_xent` ở bài `info-nce`: temperature của nó phải đi vào phép tính tensor (không bị `float(...)` hay `.item()` cắt gradient).
