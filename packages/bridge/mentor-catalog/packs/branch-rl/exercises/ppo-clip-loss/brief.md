Viết `ppo_clip_loss(new_logp, old_logp, advantages, clip_eps)`: **loss thay thế có cắt (clipped surrogate)** của PPO. Policy gradient thường chỉ dùng được dữ liệu của lần chạy hiện tại một lần; PPO muốn cập nhật nhiều bước trên cùng một rollout mà policy không "chạy quá xa" khỏi policy đã sinh ra dữ liệu. Loss này là chỗ làm điều đó: nó đo tiến bộ bằng **tỉ số xác suất** giữa policy mới và policy cũ, và **ngừng thưởng** khi tỉ số đi quá xa theo hướng có lợi.

**Công thức.** Gọi $r_t = \dfrac{\pi_\theta(a_t\mid s_t)}{\pi_{\theta_{\text{old}}}(a_t\mid s_t)}$ là tỉ số xác suất của hành động đã chọn, $A_t$ là advantage:

$$L = -\frac{1}{B}\sum_{t=1}^{B} \min\!\Big(r_t A_t,\;\; \operatorname{clip}(r_t,\,1-\epsilon,\,1+\epsilon)\,A_t\Big)$$

- `new_logp` và `old_logp` là **log**-xác suất (không phải xác suất): hàm nhận hai log và tự dựng tỉ số từ chúng, theo cách không tràn hay làm tròn xuống 0 khi log-xác suất rất âm.
- $\operatorname{clip}(r, 1-\epsilon, 1+\epsilon)$ ép $r$ vào đoạn $[1-\epsilon,\,1+\epsilon]$. Phép $\min$ chọn, ở mỗi mẫu, giá trị **bi quan hơn** trong hai số hạng.
- Dấu âm ở đầu: tối ưu hóa của PyTorch giảm loss, trong khi ta muốn **tăng** giá trị thay thế.
- $A_t$ và `old_logp` chỉ là **hằng số** của bước tối ưu này; gradient chỉ chảy vào `new_logp`.

**Vào/ra**

- `new_logp`: `float32`, `(B,)`, log-xác suất của hành động đã chọn dưới policy **đang học** (gắn gradient).
- `old_logp`: `float32`, `(B,)`, log-xác suất của cùng hành động dưới policy đã **thu thập dữ liệu** (không học nó; có thể test đưa vào tensor đang gắn gradient: nó vẫn không được nhận gradient).
- `advantages`: `float32`, `(B,)`, advantage **thô**: hàm này **không chuẩn hóa** nó (chuẩn hóa, nếu có, do nơi gọi làm trước khi đưa vào).
- `clip_eps`: số thực $\epsilon > 0$ (thường 0.1 đến 0.3).
- Trả về tensor **vô hướng** (shape `()`, float32), còn gắn với đồ thị của `new_logp`.

**Lưu ý**

- Quan sát xem ở mỗi mẫu, tùy **dấu của $A_t$** và vị trí của $r_t$ so với $1\pm\epsilon$, số hạng nào được chọn và gradient có chảy không: có vùng mà gradient bằng 0 (đó chính là cơ chế "không đi quá xa"), có vùng không.
- Không sửa các tensor vào.

Máy chấm kiểm: một ví dụ tính tay bốn mẫu, **gradient từng vùng** (A dương và A âm, tỉ số trong, dưới và trên đoạn cắt), tỉ số tính trong không gian log (log-xác suất rất âm), advantage thô không bị chuẩn hóa, advantage và `old_logp` không nhận gradient, khớp lời giải chuẩn trên nhiều $\epsilon$, và dtype/shape/tác dụng phụ.
