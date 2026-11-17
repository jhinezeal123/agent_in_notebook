Viết hàm `p_sample(model, x_t, t, sched, noise=None)`: **một bước reverse** của **DDPM** (Ho et al., 2020, *Denoising Diffusion Probabilistic Models*): từ ảnh nhiễu $x_t$ ở bước $t$, dùng mô hình đoán nhiễu để suy ra $x_{t-1}$ (nhiễu ít hơn một bước). Lấy mẫu một ảnh là lặp bước này từ nhiễu thuần tuý về tới ảnh. Lưu ý: bài này ở sao DDPM, **chưa phải paper mốc**; nó trích **Alg. 2** (lấy mẫu, dòng 3–4) của paper để bạn tập đối chiếu thuật toán với code.

Bài `noise-schedule` của bạn đã định nghĩa `make_schedule`: dùng nó để dựng `sched` (máy chấm cũng làm vậy). Hàm của bạn chỉ **đọc** các khoá của `sched`.

**Công thức (Alg. 2, dòng 3 và 4).** Với bước $t$ của paper ($t=T,\dots,1$):

$$z\sim\mathcal N(0,\mathbf I)\ \text{nếu}\ t>1,\ \text{ngược lại}\ z=0;\qquad x_{t-1}=\frac{1}{\sqrt{\alpha_t}}\Big(x_t-\frac{1-\alpha_t}{\sqrt{1-\bar\alpha_t}}\,\varepsilon_\theta(x_t,t)\Big)+\sigma_t\,z$$

Ta chọn $\sigma_t^2=\beta_t$ (một trong hai lựa chọn ở §3.2 của paper), và nhớ $1-\alpha_t=\beta_t$. Ký hiệu và chỉ số **như bài `noise-schedule`**: $t$ là chỉ số **từ 0**, $t\in\{0,\dots,T-1\}$, bước $t$ của code là bước $t+1$ của paper. Vì thế điều kiện "$t>1$" của paper thành "**$t>0$**" trong code: ở **bước cuối cùng** (chỉ số $0$, bước sinh ra ảnh sạch) **không thêm nhiễu**.

**Tham số**

- `model`: gọi như `model(x_t, t_batch)`, trong đó `t_batch` là tensor **`int64` shape `(B,)`** (mọi phần tử bằng `t`: cả batch đang ở cùng một bước); trả về $\varepsilon_\theta$ **cùng shape** với `x_t`.
- `x_t`: tensor `float32` shape `(B, C, H, W)`.
- `t`: **một số nguyên Python** trong $[0, T-1]$ (một bước cho cả batch, như vòng `for t = T..1` của Alg. 2).
- `sched`: dict từ `make_schedule(T)`; các tensor của nó shape `(T,)`.
- `noise`: `None` hoặc tensor cùng shape với `x_t`, chính là $z$. Nếu `None` và cần nhiễu thì tự lấy từ $\mathcal N(0,\mathbf I)$; nếu đã cho thì dùng đúng nó **khi $t>0$**; khi $t=0$ nhiễu **không được dùng**, dù có đưa vào.

**Trả về:** tensor `float32` shape `(B, C, H, W)` là $x_{t-1}$. Không sửa `x_t` tại chỗ.

Không cần train gì: test dùng một mô hình giả "biết trước nhiễu thật" (đoán $\varepsilon_\theta$ chính xác) và so với đáp án tính độc lập.

Trước khi code, hãy tự trả lời: ở bước cuối ($t=0$), nếu vẫn cộng $\sigma_t z$ thì ảnh trả về ra sao so với ảnh sạch, và vì sao paper bỏ nhiễu đúng ở bước đó?
