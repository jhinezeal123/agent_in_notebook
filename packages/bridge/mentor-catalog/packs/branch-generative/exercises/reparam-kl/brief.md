Hai viên gạch của **VAE** (Kingma & Welling, 2014, *Auto-Encoding Variational Bayes*). Encoder không trả về một điểm $z$ mà trả về **một phân phối** $q(z\mid x)=\mathcal N\big(\mu,\ \operatorname{diag}(\sigma^2)\big)$; ta cần (1) **lấy mẫu** $z$ từ nó sao cho gradient vẫn chảy ngược về $\mu$ và $\sigma$, và (2) đo nó **lệch** bao nhiêu so với prior $\mathcal N(0, I)$. Bạn viết hai hàm thuần nhận tensor.

**`reparameterize(mu, logvar, eps=None)`**: mẫu theo mẹo **reparameterization**,

$$z=\mu+\sigma\odot\varepsilon,\qquad \sigma=\exp\!\big(\tfrac12\,\text{logvar}\big),\qquad \varepsilon\sim\mathcal N(0,I)$$

- `mu`, `logvar`: tensor float cùng shape `(..., D)` (ví dụ `(B, D)`); `logvar` là $\log\sigma^2$ (log của **phương sai**, không phải của độ lệch chuẩn).
- `eps`: tensor cùng shape với `mu`, hoặc `None`.
  - `eps` được truyền vào: dùng **đúng** nó (đây là cách máy chấm kiểm giá trị một cách tất định).
  - `eps=None`: tự lấy $\varepsilon$ từ $\mathcal N(0,1)$, **mỗi phần tử một số độc lập**, cùng shape, kiểu số và thiết bị với `mu`.
- Trả về `z` cùng shape với `mu`. Gradient phải chảy về cả `mu` và `logvar` (kể cả khi `eps=None`); $\varepsilon$ là hằng số, không có gradient.

**`kl_gaussian(mu, logvar)`**: KL dạng đóng giữa phân phối của encoder và prior chuẩn, **tính cho từng mẫu**:

$$D_{\mathrm{KL}}\big(\mathcal N(\mu,\sigma^2 I)\ \|\ \mathcal N(0,I)\big)=-\frac12\sum_{j=1}^{D}\Big(1+\text{logvar}_j-\mu_j^2-e^{\text{logvar}_j}\Big)$$

- `mu`, `logvar`: shape `(..., D)`. Trả về shape `(...)`: **cộng theo chiều latent** $D$ (trục cuối) và bỏ trục đó; **không** lấy trung bình theo batch (việc đó là của bài sau, `vae-elbo`).
- Hai ca kiểm nhanh: $\mu=0,\ \text{logvar}=0$ cho đúng $0$; KL luôn $\ge 0$.

Không dùng `torch.distributions`; viết thẳng bằng phép toán tensor. Máy chấm so với lời giải chuẩn, với các giá trị tính tay, và với gradient. Trước khi code, hãy tự trả lời: `eps` được lấy ra rồi mà không dính gì tới `mu` và `logvar` thì vì sao gradient vẫn chảy qua được, trong khi "lấy mẫu thẳng từ $q$" (`torch.normal(mu, std)`, hay `Normal(mu, std).sample()`) thì không cho gradient đúng?
