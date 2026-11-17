Viết hàm `q_sample(x0, t, noise, sched)`: cho một batch ảnh sạch `x0` và mỗi ảnh một bước `t` riêng, trả về ảnh đã bị nhiễu tới đúng bước đó **trong một lần tính**, không cần đi qua từng bước. Đây là **quá trình thuận** (forward process) của **DDPM** (Ho et al., 2020, *Denoising Diffusion Probabilistic Models*). Lưu ý: bài này ở sao DDPM, **chưa phải paper mốc**; nó trích **Eq. 4** của paper để bạn tập đối chiếu công thức với code.

Bài `noise-schedule` của bạn đã định nghĩa `make_schedule`: dùng lại nó để dựng `sched` (máy chấm cũng làm vậy). Bạn không cần viết lại lịch nhiễu, chỉ **đọc** các khoá của `sched`.

**Công thức.** Eq. 4 của paper cho $q(x_t\mid x_0)=\mathcal N\big(x_t;\sqrt{\bar\alpha_t}\,x_0,\;(1-\bar\alpha_t)\mathbf I\big)$. Lấy mẫu từ nó bằng reparameterization (cùng mẹo reparameterization như trong VAE):

$$x_t=\sqrt{\bar\alpha_t}\;x_0+\sqrt{1-\bar\alpha_t}\;\varepsilon,\qquad \varepsilon\sim\mathcal N(0,\mathbf I)$$

(đây cũng là đối số của $\varepsilon_\theta$ ở dòng 5 của Alg. 1). Ký hiệu và cách đánh số **như bài `noise-schedule`**: $t$ ở đây là chỉ số **từ 0** vào các mảng của `sched` (phần tử $t$ ứng với bước $t+1$ của paper).

**Tham số**

- `x0`: tensor `float32` shape `(B, C, H, W)`, một batch ảnh sạch.
- `t`: tensor **`int64`** shape `(B,)`, **mỗi ảnh một bước khác nhau**, giá trị trong $[0, T-1]$.
- `noise`: tensor cùng shape và kiểu với `x0`, chính là $\varepsilon$ (đã lấy mẫu sẵn, hàm **không tự sinh** nhiễu: để máy chấm so được từng con số).
- `sched`: dict từ `make_schedule(T)`; các tensor của nó shape `(T,)`.

**Trả về:** tensor `float32` shape `(B, C, H, W)`: ảnh thứ $b$ nhiễu theo bước `t[b]` (hệ số lấy theo `t[b]`, không phải theo `t[0]`).

Ràng buộc: không sửa `x0`, `noise`, `t` tại chỗ; không cần vòng lặp qua batch (mỗi ảnh một hệ số, nhưng cả batch tính một lần). Test dùng dữ liệu tự sinh.

Trước khi code, hãy tự hỏi: các hệ số $\sqrt{\bar\alpha_t}$ lấy ra theo `t` có shape `(B,)`, còn ảnh có shape `(B, C, H, W)`. Hai shape đó ghép với nhau bằng broadcasting thế nào, và nó dễ ghép nhầm ở trục nào?
