Ba việc nhỏ để nắm autograd: lấy gradient mà không để lại dấu vết, chặn gradient chảy vào một nhánh, và sửa tham số mà không bị autograd ghi lại.

**1. `grads_of(loss_fn, params)`**: `params` là list các tensor lá (`requires_grad=True`), `loss_fn()` không nhận đối số, dùng các tensor đó và trả về một tensor **vô hướng** (shape `()`). Trả về **list** gradient $\partial L / \partial p$, mỗi phần tử cùng shape với tham số tương ứng.

- Không được để lại dấu vết trên tham số: sau khi gọi, `p.grad` của mọi tham số phải **y như trước** (vẫn `None` nếu trước đó là `None`, giữ nguyên giá trị nếu trước đó đã có).
- Gọi hai lần liên tiếp phải ra cùng một kết quả.
- API nên tìm hiểu: `torch.autograd.grad`.

**2. `td_loss(q_sa, rewards, q_next, gamma)`**: loss của DQN. `q_sa` shape `(B,)` là $Q(s, a)$ của hành động đã chọn, `rewards` shape `(B,)`, `q_next` shape `(B, A)` là $Q$ của **mạng target** ở trạng thái kế tiếp, `gamma` là số thực. Trả về tensor vô hướng:

$$y_i = r_i + \gamma \max_{a'} Q_{\text{next}}(i, a'), \qquad L = \frac{1}{B}\sum_i \big(Q(s_i, a_i) - y_i\big)^2$$

- $y$ là **hằng số** đối với việc tối ưu: sau `L.backward()`, gradient phải chảy vào `q_sa` nhưng **không được** chảy vào `q_next` (`q_next.grad` vẫn là `None`), dù `q_next` có `requires_grad=True`.

**3. `ema_update(target_params, online_params, tau)`**: hai list tham số cùng shape từng cặp (ví dụ `list(net.parameters())`). Cập nhật **tại chỗ** từng tham số của target:

$$\theta_{\text{target}} \leftarrow \tau\, \theta_{\text{target}} + (1 - \tau)\, \theta_{\text{online}}$$

- Không trả về gì. Các tham số target phải vẫn là **chính những tensor đó** (cùng object, để optimizer và module vẫn trỏ đúng), vẫn là tensor lá có `requires_grad=True`, và phép cập nhật không được ghi vào đồ thị autograd.
- `online_params` không đổi.
