**Thí nghiệm cuối.** Bạn đã có đủ hai nửa của một vòng lặp PPO: `collect_rollout` (bài `ppo--rollout`: thu dữ liệu và tính advantage) và `ppo_update` (bài `ppo-update`: loss có cắt, value loss, entropy, nhiều epoch trên minibatch; bài đó dùng lại `ppo_clip_loss` của bạn). Giờ **nối chúng thành vòng train và cho policy chơi thật**. Paper (Schulman và cộng sự, 2017) đánh giá PPO trên các tác vụ điều khiển liên tục MuJoCo (7 môi trường, 1 triệu bước mỗi môi trường): thiết lập mạnh nhất, cắt với $\epsilon = 0{,}2$, có điểm chuẩn hóa trung bình khoảng 0,82 (Bảng 1; con số nhớ theo paper, hãy đối chiếu lại); trên MuJoCo paper dùng hai mạng riêng cho policy và value, mỗi mạng hai tầng ẩn 64 nơ-ron tanh, đúng như `ActorCritic` cho sẵn. Bản thu nhỏ: **CartPole** thuần NumPy, khoảng **50 000 bước** môi trường, nửa phút đến vài phút trên CPU, **không cần Internet, không cần GPU**.

**Cho sẵn** (phần "Cho sẵn của paper", bạn không phải viết): hằng `OBS_DIM = 4`, `N_ACTIONS = 2`, `MAX_STEPS = 200`; lớp `CartPole()` với `reset(seed=None) -> obs` và `step(action) -> (obs, reward, done, truncated)`; `ActorCritic()`: `policy(obs)` với `obs` shape `(B, 4)` trả về `(logits, value)`; `evaluate(policy_fn, episodes=20, seed=0)` trả return trung bình của một chính sách `policy_fn(obs) -> hành động`; `plot_returns(returns)` vẽ đường học. Return tối đa của một episode là 200; chọn hành động ngẫu nhiên thì trung bình chỉ khoảng 20.

**Việc của bạn: một cell code mà chạy xong thì có biến toàn cục `policy`:** một `ActorCritic` đã được train bằng PPO (trên CPU).

| mục | giá trị gợi ý (đổi được, miễn đúng ý) |
|---|---|
| số vòng lặp | 50; mỗi vòng thu `T = 1024` bước bằng `collect_rollout` rồi cập nhật bằng `ppo_update` |
| optimizer | Adam, learning rate $10^{-3}$, một optimizer cho cả actor và critic |
| $\gamma$, $\lambda$ (GAE) | 0,99; 0,95 |
| `ppo_update` | `clip_eps = 0,2`, `vf_coef = 0,5`, `ent_coef = 0,01`, `epochs = 4`, `minibatch_size = 64` (mặc định `max_grad_norm = 0,5`) |
| chuẩn hóa advantage | **trước** khi gọi `ppo_update`: trừ trung bình, chia độ lệch chuẩn của cả `T` advantage (cộng $10^{-8}$ vào mẫu số) |
| seed | `torch.manual_seed(...)`, một `torch.Generator` có seed dùng cho cả `collect_rollout` lẫn `ppo_update`; môi trường: `reset(seed=...)` một lần ở đầu, rồi truyền tiếp `obs` mà `collect_rollout` trả về |

Chi tiết dễ quên: `collect_rollout` trả về `obs` (trạng thái hiện tại của môi trường) để lần gọi sau **chạy tiếp**: đừng reset lại mỗi vòng. Và advantage của `ppo_update` đã được chuẩn hóa sẵn từ ngoài: hàm `ppo_update` của bạn không làm việc đó.

(Paper dùng learning rate $3 \cdot 10^{-4}$, `T = 2048`, 10 epoch cho MuJoCo; trên CartPole nhỏ này $10^{-3}$ với 4 epoch học nhanh hơn. Nếu bạn chọn learning rate $3 \cdot 10^{-4}$ thì cho thêm vòng lặp để đạt cùng ngưỡng.)

**Máy chấm không train lại cho bạn.** Chạy xong cell train thì bấm **Chấm bài**: máy chấm đọc `policy` đang sống trong kernel, cho nó chơi **lấy mẫu hành động từ phân phối của policy** (đúng như lúc thu dữ liệu: PPO là chính sách ngẫu nhiên, paper cũng báo return của chính sách ngẫu nhiên lúc train) trên **20 episode mới** (seed riêng) và báo:

- `mean_return`: return trung bình trên 20 episode đó. **Đạt khi ≥ 150** (tối đa 200; chính sách ngẫu nhiên ≈ 20).
- `greedy_return`: return khi luôn chọn hành động có logit lớn nhất (chỉ báo: thường cao hơn `mean_return`).
- `random_return`: return của chính sách ngẫu nhiên trên cùng seed (chỉ báo; `policy` phải hơn nó gấp đôi trở lên).
- `policy_entropy`: entropy trung bình của policy trên các trạng thái đã gặp (chỉ báo; $\ln 2 \approx 0{,}69$ là hai hành động đều nhau, gần 0 là gần như tất định).
- `value_start`: $V$ trung bình ở trạng thái đầu episode (chỉ báo; phải hữu hạn và dưới 500).

Lưu ý: `policy` phải là biến toàn cục của kernel khi bấm Chấm bài (đừng đổi tên, đừng chạy lại cell "Code của bạn từ các bài trước" sau khi train: nó định nghĩa lại các hàm). Giữ mô hình trên CPU.
