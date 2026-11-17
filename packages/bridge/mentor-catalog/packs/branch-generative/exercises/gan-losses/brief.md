Viết hai hàm loss của **GAN** (Goodfellow et al., 2014, *Generative Adversarial Nets*). Discriminator $D$ nhận một ảnh và nhả ra **logit** $\ell$ (một số thực, chưa qua sigmoid); xác suất nó cho là "ảnh thật" là $D=\sigma(\ell)$. Hai người chơi: $D$ muốn phân biệt thật/giả, generator $G$ muốn lừa được $D$. Bạn viết loss của từng bên, nhận **logits**.

**`d_loss(d_real_logits, d_fake_logits)`**: loss của discriminator, bằng cross-entropy nhị phân với nhãn **thật = 1, giả = 0**, trung bình trong từng nhóm rồi **cộng** hai hạng (không chia 2):

$$L_D=-\,\mathbb E_{x\sim p_\text{data}}\big[\log D(x)\big]\;-\;\mathbb E_{z}\big[\log\big(1-D(G(z))\big)\big]$$

- `d_real_logits`: logits của $D$ trên ảnh **thật**; `d_fake_logits`: logits của $D$ trên ảnh **giả** $G(z)$. Hai tensor float shape bất kỳ (thường `(B,)` hoặc `(B, 1)`); số phần tử của hai nhóm **có thể khác nhau**. Mỗi hạng là trung bình của nhóm của nó.

**`g_loss_nonsat(d_fake_logits)`**: loss **non-saturating** của generator (cách Goodfellow đề nghị dùng trong thực tế), $G$ muốn $D(G(z))\to 1$:

$$L_G=-\,\mathbb E_{z}\big[\log D(G(z))\big]$$

- `d_fake_logits`: logits của $D$ trên ảnh giả, shape bất kỳ; trả về trung bình trên mọi phần tử.

Cả hai hàm trả về **một số** (tensor shape `()`), và:

- Phải **ổn định số** với logits rất lớn hoặc rất nhỏ (hàng trăm, kể cả $\pm 200$): loss và gradient hữu hạn và đúng. Đừng tính `sigmoid` rồi mới lấy `log`; PyTorch có sẵn hàm làm việc đó từ logits.
- Gradient phải chảy về `d_real_logits` và `d_fake_logits`. Đặc biệt `g_loss_nonsat` **không được `detach`**: logits của $D$ đang nối ngược về $G$, và đó chính là đường gradient để $G$ học. (Chiều ngược lại, khi cập nhật $D$ thì ảnh giả phải được `detach` để $G$ không bị cập nhật nhầm: việc đó nằm ở vòng lặp train, không nằm trong hai hàm này.)
- Không cần train GAN thật: chỉ viết đúng hai hàm. Test dùng dữ liệu tự sinh.

Trước khi code, hãy tự trả lời: nếu $D$ rất tự tin ảnh là giả ($\ell\ll0$) thì loss non-saturating của $G$ lớn hay nhỏ, và gradient của nó theo $\ell$ lớn hay nhỏ? Vì sao đó là điều ta muốn ở một người chơi đang thua?
