Ráp **VAE** hoàn chỉnh (Kingma & Welling, 2014): một mạng MLP nhỏ gồm encoder, bước lấy mẫu $z$, decoder, rồi loss $=-\text{ELBO}$. Bài `reparam-kl` của bạn đã định nghĩa `reparameterize` và `kl_gaussian`: **dùng lại** chúng (đừng viết lại). Bạn viết một `class VAE(nn.Module)` và một hàm `elbo_loss`.

**`VAE(in_dim=16, hidden=32, latent=4)`** có đúng các thuộc tính sau (máy chấm chép trọng số theo tên, nên giữ đúng tên và cấu trúc):

| thuộc tính | là gì |
|---|---|
| `enc` | `nn.Sequential(nn.Linear(in_dim, hidden), nn.ReLU())` |
| `fc_mu` | `nn.Linear(hidden, latent)`: ra $\mu$ |
| `fc_logvar` | `nn.Linear(hidden, latent)`: ra $\text{logvar}=\log\sigma^2$ |
| `dec` | `nn.Sequential(nn.Linear(latent, hidden), nn.ReLU(), nn.Linear(hidden, in_dim))` |

**`VAE.forward(x, eps=None)`**: `x` shape `(B, in_dim)`, giá trị trong $[0,1]$ (pixel nhị phân hoặc xám). Chạy `enc` rồi `fc_mu` và `fc_logvar` để có $\mu$ và `logvar` (đều `(B, latent)`), lấy $z$ bằng `reparameterize(mu, logvar, eps)` (truyền thẳng `eps`; máy chấm dùng nó để kiểm tất định), rồi cho $z$ qua `dec`. Trả về **ba tensor**: `(x_logits, mu, logvar)`, trong đó `x_logits` shape `(B, in_dim)` là **logits** của decoder, **chưa qua sigmoid**.

**`elbo_loss(x, x_logits, mu, logvar, beta=1.0)`**: số cần **giảm** khi train, tức $-\text{ELBO}$ (có hệ số $\beta$ trước KL):

$$\mathcal L=\frac1B\sum_{b=1}^{B}\Big[\ \underbrace{\sum_{i}\mathrm{BCE}\big(x_{b,i},\ \ell_{b,i}\big)}_{\text{tái tạo (reconstruction)}}\ +\ \beta\;D_{\mathrm{KL}}\big(q(z\mid x_b)\,\|\,\mathcal N(0,I)\big)\Big],\qquad \mathrm{BCE}(x,\ell)=-\big[x\log\sigma(\ell)+(1-x)\log(1-\sigma(\ell))\big]$$

- `x`, `x_logits`: `(B, D)`; `mu`, `logvar`: `(B, latent)`. Trả về **một số** (tensor shape `()`).
- Tái tạo của **một ảnh** là **tổng** BCE trên mọi pixel của nó; rồi trung bình theo batch. KL của một ảnh là `kl_gaussian` (đã cộng theo chiều latent); rồi cũng trung bình theo batch. Hai hạng phải cùng đơn vị "nat trên một ảnh" thì $\beta=1$ mới đúng nghĩa ELBO.
- BCE tính **từ logits**, ổn định số với logits rất lớn (hàng trăm): PyTorch có sẵn hàm làm việc này, đừng tự `sigmoid` rồi lấy `log`.
- Gradient phải chảy về `x_logits`, `mu` và `logvar`.

Máy chấm kiểm: cấu trúc, đầu ra khi chép trọng số chuẩn vào model của bạn, đường đi của noise, giá trị loss tính tay, quy ước cộng/trung bình, $\beta$, logits cực lớn, gradient. Trước khi code, hãy tự trả lời: nếu tái tạo lấy **trung bình theo pixel** (mặc định của nhiều hàm loss) trong khi KL cộng theo chiều latent, hai hạng chênh nhau bao nhiêu lần với ảnh 784 pixel, và optimizer sẽ "ưu tiên" hạng nào?
