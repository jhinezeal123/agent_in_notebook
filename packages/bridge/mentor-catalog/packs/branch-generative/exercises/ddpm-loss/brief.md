Viết hàm `ddpm_loss(model, x0, sched, t=None, noise=None)`: loss "đơn giản" $L_\text{simple}$ để train **DDPM** (Ho et al., 2020, *Denoising Diffusion Probabilistic Models*). Lưu ý: bài này ở sao DDPM, **chưa phải paper mốc**; nó trích **Eq. 14** và **Alg. 1** của paper để bạn tập đối chiếu công thức với code.

Bài `q-sample` của bạn đã định nghĩa `q_sample(x0, t, noise, sched)`: **dùng lại nó** để tạo ảnh nhiễu (máy chấm cũng chạy trên `q_sample` của bạn). Mô hình không phải đoán ảnh sạch mà **đoán nhiễu** đã thêm vào.

**Công thức.** Eq. 14 của paper:

$$L_\text{simple}(\theta)=\mathbb E_{t,\,x_0,\,\varepsilon}\Big[\big\|\varepsilon-\varepsilon_\theta\big(\sqrt{\bar\alpha_t}\,x_0+\sqrt{1-\bar\alpha_t}\,\varepsilon,\;t\big)\big\|^2\Big]$$

và Alg. 1 (dòng 2–5) nói cách ước lượng nó mỗi lần cập nhật: lấy $x_0$ từ dữ liệu, lấy bước $t$ **đều** trong tập các bước, lấy $\varepsilon\sim\mathcal N(0,\mathbf I)$, rồi một bước gradient trên bình phương sai khác giữa $\varepsilon$ và $\varepsilon_\theta(x_t,t)$. Hàm của bạn trả về đúng con số mà bước gradient đó lấy đạo hàm. Cách đánh số bước **như bài `noise-schedule`**: $t$ là chỉ số **từ 0**, nên $t$ thuộc $\{0,1,\dots,T-1\}$ (bước $t$ của code là bước $t+1$ của paper).

**Tham số**

- `model`: một `nn.Module` (hoặc hàm) gọi như `model(x_t, t)`: nhận ảnh nhiễu `x_t` shape `(B, C, H, W)` và `t` tensor **`int64` shape `(B,)`**, trả về dự đoán nhiễu **cùng shape** với `x_t`.
- `x0`: tensor `float32` shape `(B, C, H, W)`, ảnh sạch.
- `sched`: dict từ `make_schedule(T)` (bài `noise-schedule`); $T$ là số phần tử của `sched["betas"]`.
- `t`: `None` hoặc tensor `int64` shape `(B,)`. Nếu là `None`, hàm tự **lấy ngẫu nhiên đều** một bước **cho mỗi ảnh** trong `[0, T-1]` (đủ cả hai đầu, không lố ra `T`). Nếu đã cho thì dùng đúng nó.
- `noise`: `None` hoặc tensor cùng shape với `x0`. Nếu là `None`, hàm tự lấy từ $\mathcal N(0,\mathbf I)$; nếu đã cho thì dùng đúng nó. Nhiễu **dùng để tạo `x_t`** và nhiễu **mô hình phải đoán** là **cùng một tensor**.

**Trả về:** một tensor shape `()` (một số) bằng **trung bình trên mọi phần tử** của $(\varepsilon-\varepsilon_\theta)^2$ (như `F.mse_loss` mặc định; paper viết bình phương chuẩn, tức tổng, nhưng cách chuẩn trong code chỉ khác một hằng số). Gradient phải chảy về tham số của `model`.

Không cần train mô hình thật: test dùng vài mô hình giả nhỏ tự dựng và dữ liệu tự sinh.

Trước khi code, hãy tự trả lời: mô hình nhận `x_t` và `t`, vậy nó cần biết bước nào để đoán nhiễu, và nếu bạn đưa cho nó `t` khác với `t` đã dùng khi nhiễu ảnh thì chuyện gì xảy ra?
