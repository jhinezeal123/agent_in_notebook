Viết hàm `make_schedule(T, beta_start=1e-4, beta_end=0.02)` dựng **lịch nhiễu** (noise schedule) của **DDPM** (Ho et al., 2020, *Denoising Diffusion Probabilistic Models*). Lưu ý: bài này ở sao DDPM, **chưa phải paper mốc**; mỗi bài của sao chỉ trích đúng chỗ trong paper (ở đây là §2 dưới Eq. 4 và §4) để bạn tập đối chiếu công thức trên giấy với code. Các bài sau (`q-sample`, `ddpm-loss`, `p-sample`) đều nhận cái bạn trả về ở đây.

**Công thức (paper).** Quá trình thuận (forward process) thêm nhiễu Gauss vào ảnh qua $T$ bước, bước $t$ dùng phương sai $\beta_t$. Đặt

$$\alpha_t := 1-\beta_t,\qquad \bar\alpha_t := \prod_{s=1}^{t}\alpha_s$$

(đây là ký hiệu ngay dưới Eq. 4 của paper), và §4 chọn $\beta_t$ **tăng tuyến tính** (linear) từ $\beta_1=10^{-4}$ đến $\beta_T=0.02$ với $T=1000$.

**Chỉ số: đánh số từ 0.** Paper đánh số bước $t=1,\dots,T$. Trong code của sao DDPM ta đánh số **từ 0**: mảng có $T$ phần tử, phần tử thứ $i$ ($i=0,\dots,T-1$) ứng với bước $t=i+1$ của paper. Từ đây mọi bài viết $\beta_t,\alpha_t,\bar\alpha_t$ với $t$ **đã là chỉ số từ 0**, nên tích ở trên thành $\bar\alpha_t=\prod_{s=0}^{t}\alpha_s$ (chạy từ bước $0$ đến bước $t$, cả hai đầu):

- $\beta_0=$ `beta_start`, $\beta_{T-1}=$ `beta_end`, và $\beta_t$ cách đều nhau (**cả hai đầu mút đều có mặt**);
- $\bar\alpha_0=\alpha_0$ (mới đi qua đúng một bước), $\bar\alpha_{T-1}$ rất nhỏ.

**Hàm trả về** một `dict` gồm năm tensor 1 chiều, **mỗi tensor shape `(T,)` kiểu `float32`**, với đúng các khoá:

| khoá | giá trị |
|---|---|
| `"betas"` | $\beta_t$ |
| `"alphas"` | $\alpha_t$ |
| `"alpha_bar"` | $\bar\alpha_t$ |
| `"sqrt_alpha_bar"` | $\sqrt{\bar\alpha_t}$ |
| `"sqrt_one_minus_alpha_bar"` | $\sqrt{1-\bar\alpha_t}$ |

Hai hàng cuối là hai hệ số của Eq. 4, $q(x_t\mid x_0)=\mathcal N\big(x_t;\sqrt{\bar\alpha_t}\,x_0,\,(1-\bar\alpha_t)\mathbf I\big)$, mà bài `q-sample` sẽ dùng.

Ca biên: $T=1$ và $T=2$ phải chạy đúng. Không cần vòng lặp Python. Test dùng dữ liệu tự sinh.

Trước khi code, hãy tự dự đoán (rồi kiểm ở lab): sau $T=1000$ bước, còn bao nhiêu phần trăm "tín hiệu" của ảnh gốc? Và khoảng chừng bước nào thì tín hiệu chỉ còn một nửa: gần đầu, giữa hay cuối?
