**Thu thập một rollout cho PPO.** Một vòng lặp của PPO (Algorithm 1, §5) có hai nửa: (a) **chạy policy hiện tại** trong môi trường $T$ bước để thu dữ liệu, rồi tính advantage $\hat A_t$ (Eq. 10–12); (b) tối ưu loss thay thế nhiều epoch trên dữ liệu đó (bài `ppo-update` của bạn). Bài này viết nửa (a). Bạn đã có `compute_gae` (bài `gae`): **dùng lại**, không viết lại. `ActorCritic` và `CartPole` được cho sẵn ở dưới (xem phần "Cho sẵn"): `policy(obs)` với `obs` shape `(B, 4)` trả về `(logits, value)`, `logits` shape `(B, 2)`, `value` shape `(B,)`.

Viết `collect_rollout(env, obs, policy, steps, gamma, lam, generator)`:

- `env`: một `CartPole()` đang chạy; `obs`: trạng thái hiện tại của nó (`float32`, shape `(4,)`; nơi gọi đã `reset(seed=...)` lần đầu). Môi trường **không** được reset ở đầu hàm: lần gọi sau chạy tiếp đúng episode còn dở của lần gọi trước.
- `policy`: nn.Module như trên. `steps`: $T$, số bước môi trường cần chạy, **đúng** $T$ bước. `gamma`, `lam`: truyền cho `compute_gae`.
- `generator`: một `torch.Generator`. Mỗi bước, hành động được **lấy mẫu** từ phân phối softmax của `logits` (không phải argmax) bằng `torch.multinomial` với `generator` này, để chạy lại cùng seed ra đúng cùng kết quả.

**Mỗi bước** lưu lại: trạng thái `obs` **trước** khi hành động, hành động đã chọn, **log xác suất** policy gán cho hành động đó (`old_logp`: con số cố định so sánh với policy mới ở bước cập nhật), và `value` $V(s_t)$ policy ước lượng. Rồi cho môi trường chạy một bước: `env.step(action)` trả về `(obs_mới, reward, done, truncated)`. Cờ kết thúc episode của bước đó là `done or truncated` (như hầu hết cài đặt PPO phổ biến, bài này coi việc bị cắt ở 200 bước như kết thúc). Khi episode kết thúc, gọi `env.reset()` (không đối số) và đi tiếp từ trạng thái mới.

**Sau $T$ bước**, gọi `compute_gae` của bạn với `rewards`, `values`, `dones` (mỗi cái `float32`, shape `(T,)`) và `last_value`: giá trị $V$ của trạng thái hiện tại sau bước cuối (chỗ rollout bị cắt), để bootstrap phần tương lai chưa chạy tới. (Nếu bước cuối vừa kết thúc episode thì `dones[T-1] = 1` đã chặn `last_value`: giá trị nào cũng được.)

**Trả về** bộ ba `(batch, obs, episode_returns)`:

- `batch`: `dict` đúng các khóa mà `ppo_update` cần: `"obs"` `(T, 4)` `float32`; `"actions"` `(T,)` **`int64`**; `"old_logp"` `(T,)` `float32`; `"advantages"` `(T,)` và `"returns"` `(T,)` (đầu ra của `compute_gae`). **Không** tensor nào dính đồ thị gradient (hãy nghĩ vì sao dữ liệu thu thập phải ngoài đồ thị). `advantages` **chưa** chuẩn hóa: việc đó để nơi gọi làm.
- `obs`: trạng thái hiện tại của môi trường sau $T$ bước (`float32`, `(4,)`), để lần gọi sau chạy tiếp.
- `episode_returns`: `list` các số thực, mỗi phần tử là tổng reward của một episode **vừa kết thúc trong rollout này** (theo thứ tự). Episode đang dở ở cuối không tính; episode còn dở từ lần gọi trước chỉ tính phần nằm trong rollout này.

Máy chấm kiểm: shape/dtype; các `obs`, `actions` khớp một lần **chạy lại thật** trên môi trường (đúng trạng thái trước mỗi bước, reset đúng chỗ); `old_logp` khớp policy tính lại; `advantages` và `returns` khớp `compute_gae` với đúng `gamma`, `lam`, `dones`, `last_value`; ca rollout cắt giữa episode (bootstrap bằng tay); `episode_returns`; chạy tiếp từ `obs` được đưa vào; tần suất hành động theo đúng softmax; dùng đúng `generator`; không có đồ thị gradient.
