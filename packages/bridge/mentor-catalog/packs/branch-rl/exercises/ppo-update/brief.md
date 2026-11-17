Viết `ppo_update(policy, optimizer, batch, clip_eps, vf_coef, ent_coef, epochs, minibatch_size, generator, max_grad_norm=0.5)`: **bước cập nhật của PPO** trên một rollout đã thu thập. Đây là chỗ ráp mọi mảnh của chòm RL lại: loss thay thế có cắt (bài `ppo-clip-loss`), loss giá trị, bonus entropy, và vòng lặp tối ưu nhiều **epoch** trên các **minibatch** xáo trộn. Dữ liệu (`advantages`, `returns`) đã được bài `gae` tính sẵn: hàm này chỉ học từ chúng.

**Tổng loss** trên mỗi minibatch:

$$L = L_{\text{clip}} + c_v\, L_V - c_e\, H$$

- $L_{\text{clip}}$: loss PPO có cắt trên minibatch: **gọi lại `ppo_clip_loss` của bạn** (bài trước của bạn đã định nghĩa `ppo_clip_loss(new_logp, old_logp, advantages, clip_eps)`; bài `uses` chạy code của bạn ở đó trước, nên nó đã có sẵn).
- $L_V$: sai số bình phương trung bình giữa giá trị `value` mạng dự đoán và `returns` (`F.mse_loss`); $c_v$ = `vf_coef`. `returns` là mục tiêu, không nhận gradient.
- $H$: **entropy** trung bình của phân phối hành động của policy, $H = -\frac1B\sum_t\sum_a \pi(a\mid s_t)\log\pi(a\mid s_t)$; $c_e$ = `ent_coef`. Entropy cao nghĩa là policy còn khám phá: ta muốn **tăng** nó nên nó mang dấu **trừ** trong loss.

**Vào/ra**

- `policy`: `nn.Module`; `policy(obs)` trả về cặp `(logits, value)` với `logits` shape `(B, A)` và `value` shape `(B,)`. Gọi `policy` **đúng một lần cho mỗi minibatch**.
- `optimizer`: một `torch.optim.Optimizer` đã được dựng trên `policy.parameters()`.
- `batch`: `dict` các tensor cùng độ dài `N` ở chiều đầu: `"obs"` `(N, d)` float32; `"actions"` `(N,)` **int64**; `"old_logp"` `(N,)` log-xác suất của hành động đã chọn lúc thu thập; `"advantages"` `(N,)` (đã chuẩn hóa nếu muốn: **hàm này không chuẩn hóa**); `"returns"` `(N,)`.
- `clip_eps`, `vf_coef`, `ent_coef`: số thực. `epochs`: số lần duyệt qua toàn bộ dữ liệu. `minibatch_size`: kích thước nhóm (nhóm cuối có thể nhỏ hơn).
- `generator`: `torch.Generator` quyết định thứ tự xáo trộn (kết quả tất định khi seed cố định).
- `max_grad_norm`: nếu không phải `None`, **cắt chuẩn gradient toàn cục** về tối đa giá trị này (`nn.utils.clip_grad_norm_` trên `policy.parameters()`), sau `backward` và trước `step`.

**Cho sẵn** (đã chạy trong notebook trước code của bạn): `minibatch_indices(n, size, generator)`: trả về danh sách các tensor chỉ số (`int64`) của một lần xáo trộn `n` mẫu bằng `generator`, chia thành các nhóm `size` mẫu. Mỗi epoch gọi nó **một lần** để có một thứ tự xáo trộn mới.

**Mỗi minibatch** làm theo thứ tự: tính `new_logp`, `entropy`, `value` từ một lần gọi `policy`; tính loss tổng; xóa gradient cũ; `backward`; cắt gradient; `optimizer.step()`.

**Trả về** một `dict` các **số Python** (`float`, không phải tensor), mỗi số là **trung bình trên mọi lần cập nhật** (epochs × số minibatch), mỗi lần tính **trước** `optimizer.step()` của chính nó:

- `"loss"`: tổng loss $L$.
- `"clip_fraction"`: tỉ lệ mẫu có $|r_t - 1| > \epsilon$ ($r_t = e^{\text{new\_logp} - \text{old\_logp}}$): bao nhiêu mẫu đã "chạm" đoạn cắt.
- `"approx_kl"`: $\operatorname{mean}(\text{old\_logp} - \text{new\_logp})$, ước lượng độ lệch giữa policy mới và cũ.

**Lưu ý**: không sửa `batch`; gradient không chảy vào `advantages`, `returns`, `old_logp` của người gọi.

Máy chấm kiểm (với policy tí hon do test tự dựng): số lần gọi `optimizer.step()`, mỗi mẫu được dùng đúng một lần mỗi epoch, thứ tự xáo trộn tất định theo `generator`, dấu của bonus entropy, value loss kéo `value` về `returns`, hướng cập nhật theo advantage, cắt chuẩn gradient, gradient không chảy vào batch, việc dùng lại `ppo_clip_loss` của bạn, các số thống kê trả về, và khớp lời giải chuẩn (tham số sau cập nhật).
