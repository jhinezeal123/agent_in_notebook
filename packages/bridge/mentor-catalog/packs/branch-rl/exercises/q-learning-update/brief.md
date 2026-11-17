Viết `q_update(Q, s, a, r, s_next, done, alpha, gamma)`, **một bước cập nhật Q-learning** trên bảng giá trị, và `q_learning(env, episodes, alpha, gamma, eps, rng)`, vòng lặp học trên một môi trường nhỏ. Bài chạy hoàn toàn bằng NumPy, không cần PyTorch.

**Bảng Q.** `Q` là mảng float shape `(S, A)`: `Q[s, a]` là ước lượng tổng thưởng chiết khấu nếu ở trạng thái `s`, làm hành động `a`, rồi sau đó làm theo chính sách tốt nhất. Q-learning học nó từ từng bước trải nghiệm $(s, a, r, s')$:

$$y = \begin{cases} r & \text{nếu } \texttt{done} \\ r + \gamma \max_{a'} Q(s', a') & \text{nếu không} \end{cases}\qquad
\delta = y - Q(s, a),\qquad Q(s, a) \leftarrow Q(s, a) + \alpha\,\delta$$

$y$ là **TD target**, $\delta$ là **TD error**. Khi `done = True`, bước vừa rồi kết thúc episode: không có trạng thái "sau" để ước lượng giá trị, nên target chỉ có thưởng.

**`q_update`**

- `Q`: `np.ndarray` float `(S, A)`. `s`, `a`, `s_next`: số nguyên. `r`: float. `done`: bool. `alpha` (bước học), `gamma` (hệ số chiết khấu): float.
- **Sửa tại chỗ** chính mảng `Q` người gọi truyền vào, **chỉ phần tử `Q[s, a]`**; không tạo bản sao, không đổi phần tử nào khác.
- Trả về **TD error** $\delta$ (target trừ `Q[s, a]` *cũ*, tính trước khi sửa) dạng float. $\delta$ không phụ thuộc `alpha`.

**`q_learning`**

- `env` có: `env.n_states`, `env.n_actions`, `env.reset()` trả về trạng thái đầu, `env.step(a)` trả về `(s_next, r, done)`. Lớp `GridWorld` cho sẵn ở ô code phía trên (lưới $n \times n$, thưởng $-1$ mỗi bước, đích ở góc dưới phải); chạy `help(GridWorld)` để xem. Test dùng cả lưới này lẫn một môi trường khác, nên đừng gắn cứng kích thước.
- `Q` khởi tạo toàn 0, shape `(env.n_states, env.n_actions)`.
- Mỗi trong `episodes` episode: `env.reset()` đúng một lần, rồi lặp tới khi `done`: chọn hành động **epsilon-greedy** theo `Q[s]` (xác suất `eps` chọn đều ngẫu nhiên trong mọi hành động, ngược lại hành động có `Q[s]` lớn nhất; đồng hạng thì chọn ngẫu nhiên giữa các hành động đó), gọi `env.step`, gọi `q_update` của bạn, chuyển sang trạng thái mới.
- `rng`: `numpy.random.Generator` do người gọi truyền vào; mọi lựa chọn ngẫu nhiên đi qua nó (không dùng `np.random.*` toàn cục).
- Trả về `Q`.

Máy chấm kiểm: các bước cập nhật tính tay (kể cả `done`), max theo đúng hàng, sau đủ episode giá trị trên lưới 4x4 hội tụ về giá trị tối ưu và chính sách greedy đi đường ngắn nhất, thêm một môi trường hành lang để chắc bạn không gắn cứng với lưới, và vòng lặp (reset đúng một lần mỗi episode, `eps = 1` thì hành động đều ngẫu nhiên, cùng seed cùng kết quả).
