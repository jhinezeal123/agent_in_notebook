Viết hàm `fm_loss(model, x1, t=None, x0=None)`: loss **conditional flow matching** với **đường thẳng** nối nhiễu tới dữ liệu (còn gọi là *rectified flow*; Lipman et al., 2022, *Flow Matching for Generative Modeling*, và Liu et al., 2022, *Flow Straight and Fast*). Mô hình không đoán nhiễu như DDPM mà đoán **vận tốc**: hướng và tốc độ để đi từ nhiễu về dữ liệu. Lưu ý: bài này ở sao Flow matching, **chưa phải paper mốc** (paper mốc của nhánh sinh là DDPM).

**Quy ước (đọc kỹ, vì dễ ngược).** Thời gian $t\in[0,1]$:

- $t=0$ là **nhiễu** $x_0\sim\mathcal N(0,\mathbf I)$, $t=1$ là **dữ liệu** $x_1$ (ngược với DDPM, nơi $t$ lớn là nhiễu).
- Điểm tại thời gian $t$ trên đường thẳng giữa chúng: $x_t=(1-t)\,x_0+t\,x_1$.
- Mô hình $v_\theta(x_t,t)$ phải đoán **vận tốc** của đường đi đó, tức đạo hàm theo thời gian $\dfrac{d x_t}{dt}$:

$$u=x_1-x_0,\qquad L_\text{FM}(\theta)=\mathbb E_{t,\,x_0,\,x_1}\big\|v_\theta(x_t,t)-u\big\|^2$$

Mỗi lần cập nhật: lấy $x_1$ từ dữ liệu, $t$ đều trong $[0,1)$, $x_0$ từ $\mathcal N(0,\mathbf I)$, rồi hồi quy $v_\theta$ về $u$. (Lúc sinh ảnh, bài `euler-sampler` sẽ đi từ nhiễu tại $t=0$ về dữ liệu tại $t=1$ bằng cách tích phân $v_\theta$.)

**Tham số**

- `model`: gọi như `model(x_t, t)` với `x_t` shape giống `x1` và `t` tensor `float32` **shape `(B,)`**, trả về vận tốc dự đoán **cùng shape** với `x_t`.
- `x1`: tensor `float32` shape **`(B, ...)`** với các chiều sau batch bất kỳ: `(B, D)` (vectơ) hoặc `(B, C, H, W)` (ảnh) đều phải chạy.
- `t`: `None` hoặc tensor `float32` shape `(B,)`. Nếu `None`, lấy **một số ngẫu nhiên đều trong $[0,1)$ cho mỗi mẫu** trong batch; nếu đã cho thì dùng đúng nó.
- `x0`: `None` hoặc tensor cùng shape với `x1`. Nếu `None`, lấy từ $\mathcal N(0,\mathbf I)$; nếu đã cho thì dùng đúng nó.
- Cái đưa cho `model` là **chính `t` shape `(B,)`** (không phải bản đã đổi shape để nội suy).

**Trả về:** tensor shape `()` bằng **trung bình trên mọi phần tử** của $(v_\theta-u)^2$. Gradient phải chảy về tham số của `model`.

Không cần train mô hình thật: test dùng vài mô hình giả nhỏ và dữ liệu tự sinh.

Trước khi code, hãy tự trả lời: `t` có shape `(B,)` còn `x1` có shape `(B, ...)`. Để tính $(1-t)x_0+t\,x_1$ với **mỗi mẫu một $t$ riêng**, bạn phải làm gì với `t`, và làm sao để cùng một đoạn code chạy được cho cả `(B, D)` lẫn `(B, C, H, W)`?
