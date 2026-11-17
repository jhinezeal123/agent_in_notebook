**Ráp các mảnh của DQN thành một agent.** Bạn đã có `ReplayBuffer` (bài `replay-buffer`) và `dqn_loss` (bài `dqn-td-loss`): **dùng lại**, không viết lại. Còn thiếu năm mảnh nhỏ để một vòng train DQN (Algorithm 1 trong phần Methods của paper) chạy được. Bài này viết đủ năm mảnh đó, mỗi mảnh test được riêng; bài thí nghiệm sau sẽ ghép chúng thành vòng train trên CartPole (môi trường cho sẵn ở dưới).

Quan sát cho sẵn: một trạng thái CartPole là vector `obs` shape `(4,)` (`float32`), có 2 hành động (đẩy trái 0, đẩy phải 1).

**1. `QNet(obs_dim=4, n_actions=2, hidden=64)`**: một `nn.Module` (MLP) biến trạng thái thành Q-value của **mọi** hành động.

- Ba lớp `nn.Linear` có **tên thuộc tính cố định** (để máy chấm chép được trọng số): `self.fc1` (`obs_dim → hidden`), `self.fc2` (`hidden → hidden`), `self.out` (`hidden → n_actions`).
- `forward(x)`: `x` shape `(B, obs_dim)`, trả về shape `(B, n_actions)`. ReLU sau `fc1` và `fc2`; **không** có hàm kích hoạt ở đầu ra (Q-value là một số thực bất kỳ, có thể âm).

**2. `epsilon_by_step(step, eps_start, eps_end, decay_steps)`**: lịch của $\varepsilon$ cho chính sách $\varepsilon$-greedy (paper giảm $\varepsilon$ **tuyến tính** từ 1,0 xuống 0,1 trong 1 triệu bước đầu rồi giữ nguyên). Bước `0` cho `eps_start`; bước `decay_steps` cho `eps_end`; từ đó trở đi giữ ở `eps_end`. Trả về một số thực.

**3. `select_action(q_net, obs, eps, rng)`**: chọn một hành động cho **một** trạng thái.

- Với xác suất $\varepsilon$: **khám phá**, chọn một hành động **ngẫu nhiên đều** trong mọi hành động. Ngược lại (xác suất $1-\varepsilon$): **khai thác**, chọn hành động có Q-value lớn nhất.
- `obs`: mảng NumPy `(4,)`. `rng`: `numpy.random.Generator` do người gọi truyền vào: **mọi** lựa chọn ngẫu nhiên phải đi qua nó (để chạy lại được kết quả).
- Trả về một **số nguyên Python** (`int`), không phải tensor. Việc tính Q-value ở đây chỉ để chọn hành động: không được tạo đồ thị gradient.

**4. `sync_target(q_net, target_net, tau=1.0)`**: cập nhật **mạng target** (bản sao chậm của mạng chính, cho ra mục tiêu ổn định trong loss TD).

$$\bar\theta \leftarrow \tau\,\theta + (1-\tau)\,\bar\theta$$

- `tau = 1` (mặc định): **sao chép cứng** toàn bộ tham số (cách của paper: chép mỗi $C$ bước). `0 < tau < 1`: cập nhật **mềm** (một biến thể hay dùng: mỗi bước một ít).
- Sửa `target_net` **tại chỗ** (hàm không trả về gì); `q_net` không được đổi. Sau khi sao chép, `target_net` là một bản **độc lập**: học tiếp `q_net` không được làm `target_net` thay đổi theo.

**5. `dqn_train_step(q_net, target_net, optimizer, buffer, batch_size, gamma, rng)`**: **một bước học**.

- `buffer` là một `ReplayBuffer` của bạn; `optimizer` đã được dựng trên `q_net.parameters()`.
- Nếu `buffer` có **ít hơn** `batch_size` transition: chưa học gì, trả về `None`.
- Ngược lại: bốc một batch từ `buffer` bằng `rng`, đổi thành tensor (đúng dtype mà `dqn_loss` cần), tính loss bằng `dqn_loss` của bạn, một bước tối ưu cho `q_net`, rồi trả về giá trị loss như một **số Python** (`float`).
- Không đổi `target_net` (chỉ `sync_target` mới đổi nó).

Máy chấm kiểm: kiến trúc và dtype của `QNet`; các mốc và sàn của lịch $\varepsilon$; tần suất khám phá/khai thác và việc dùng đúng `rng`; sao chép cứng, độc lập, và cập nhật mềm; một bước học so với bản chuẩn (cùng batch), nhiều bước liên tiếp, `target_net` không bị đụng tới, và ca buffer chưa đủ dữ liệu.
