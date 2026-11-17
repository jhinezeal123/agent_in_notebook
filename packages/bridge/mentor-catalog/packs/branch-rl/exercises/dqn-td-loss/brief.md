Viết `dqn_loss(q_net, target_net, batch, gamma)`: **loss TD của DQN** trên một batch trải nghiệm. Đây là trái tim của DQN: nối ý tưởng Q-learning bảng (bài `q-learning-update`) với mạng nơ-ron, và là chỗ người ta hay làm sai một cách im lặng (loss vẫn ra số, chỉ là học không được).

**Ý tưởng.** Thay bảng $Q(s, a)$ bằng một mạng $Q_\theta(s) \in \mathbb{R}^{A}$ cho giá trị của cả $A$ hành động. Với mỗi transition $(s, a, r, s', \text{done})$ lấy từ replay buffer:

$$y = r + \gamma\,(1 - \text{done})\,\max_{a'} Q_{\bar\theta}(s', a'),\qquad
L = \frac{1}{B}\sum_{i=1}^{B} \ell\big(Q_\theta(s_i)[a_i] - y_i\big)$$

- $Q_\theta(s_i)[a_i]$: giá trị mà **mạng chính** `q_net` gán cho **hành động đã chọn** $a_i$ (chỉ một trong $A$ số của hàng $i$).
- $y_i$: **target**, tính bằng **mạng target** `target_net` (một bản sao cũ, cập nhật chậm, của mạng chính) trên `next_states`. Target là con số mà $Q_\theta(s_i)[a_i]$ cần tiến tới: nó **không nhận gradient**, tức là coi như hằng số (gradient chỉ chảy vào `q_net`).
- $\ell$ là **Huber loss** (như DQN dùng cắt sai số): $\ell(x) = \tfrac12 x^2$ nếu $|x| < 1$, ngược lại $|x| - \tfrac12$. Dùng `F.smooth_l1_loss` mặc định (`beta = 1`, `reduction="mean"`), không phải MSE.

**Vào/ra**

- `q_net`, `target_net`: `nn.Module` nhận `(B, d)` và trả `(B, A)`.
- `batch`: bộ năm tensor `(states, actions, rewards, next_states, dones)`:
  - `states`, `next_states`: `float32`, `(B, d)`.
  - `actions`: **`int64`**, `(B,)`, hành động đã chọn, giá trị trong `[0, A)`.
  - `rewards`: `float32`, `(B,)`.
  - `dones`: `float32`, `(B,)`, bằng 1.0 nếu transition kết thúc episode, 0.0 nếu không.
  (Đúng bộ mảng mà `ReplayBuffer.sample` ở bài trước trả về, sau khi bọc bằng `torch.from_numpy`.)
- `gamma`: số thực trong `[0, 1]`.
- Trả về một tensor **vô hướng** (shape `()`, float32) còn gắn với đồ thị tính gradient của `q_net`, để gọi `.backward()` được.

**Lưu ý.** Không sửa `batch`, không sửa trọng số của hai mạng, không gọi optimizer (hàm chỉ tính loss). Chỉ `q_net` được nhận gradient: sau `.backward()`, tham số của `target_net` phải không có gradient.

Máy chấm kiểm: một ví dụ tính tay với hai mạng tuyến tính đơn giản, việc lấy đúng Q của hành động đã chọn, mặt nạ `done`, khớp lời giải chuẩn trên nhiều batch (kể cả batch 1, `gamma = 0`), gradient (chỉ `q_net`), Huber chứ không phải MSE, và dtype/shape/tác dụng phụ. Dữ liệu tự sinh, mạng chỉ là `nn.Linear` nhỏ.
