**Biến thể của `gan-losses`.** Ở bài gốc, $G$ giảm $-\log D(G(z))$ (non-saturating). Bài này quay lại **loss minimax nguyên bản** của Goodfellow et al. (2014): $G$ **giảm** $\log\big(1-D(G(z))\big)$, tức đối kháng trực tiếp với hạng "ảnh giả" của $D$ (trò zero-sum). Đổi mỗi một chi tiết đó, rồi xem gradient thay đổi ra sao. Trước khi code, hãy trả lời câu dự đoán đi kèm bài.

**`g_loss_saturating(d_fake_logits)`**: loss minimax của generator,

$$L_G^{\text{sat}}=\mathbb E_{z}\big[\log\big(1-D(G(z))\big)\big],\qquad D=\sigma(\ell)$$

- `d_fake_logits` $\ell$: logits của $D$ trên ảnh giả $G(z)$, tensor float shape bất kỳ (thường `(B,)` hoặc `(B, 1)`). Trả về **trung bình trên mọi phần tử**, một số (tensor shape `()`).
- Giá trị luôn $\le 0$ (log của một xác suất). $G$ **giảm** nó: khi $D$ bị lừa càng nhiều (logit càng lớn) loss càng **âm hơn**.
- **Ổn định số**: loss và gradient phải hữu hạn và đúng với logits cực lớn. Cụ thể với logits $(200, -200)$ loss phải bằng $-100$ (hai ảnh: một ảnh $D$ bị lừa hoàn toàn cho giá trị $-200$, một ảnh $D$ biết chắc là giả cho giá trị $\approx 0$) và gradient theo logit là $(-0.5,\ 0)$. Đừng tính `sigmoid` rồi `1 - ·` rồi `log`; và đừng "cứu" bằng cách cộng $\varepsilon$ hay cắt (`clamp`): các cách đó làm sai giá trị và/hoặc làm gradient mất đi khi $D$ rất tự tin.
- Gradient phải chảy về `d_fake_logits` (không `detach`).
- Bài `gan-losses` của bạn đã định nghĩa `g_loss_nonsat`: máy chấm dùng nó để so gradient của hai loss; bạn không phải viết lại.

Máy chấm kiểm: giá trị tính tay, chiều của gradient (G thắng thì loss giảm), độ lớn gradient ở ba vùng ($D$ rất chắc ảnh là giả, phân vân, bị lừa), logits $\pm200$, trung bình theo phần tử, và quan hệ với `g_loss_nonsat`. Dữ liệu tự sinh, không cần train GAN.
