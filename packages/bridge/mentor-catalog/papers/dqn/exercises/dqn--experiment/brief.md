**Thí nghiệm cuối.** Bạn đã có đủ các mảnh của một agent DQN (`QNet`, `epsilon_by_step`, `select_action`, `sync_target`, `dqn_train_step`, cùng `ReplayBuffer` và `dqn_loss` từ các bài trước). Giờ **ghép thành vòng train và cho nó chơi thật**. Paper (Nature 2015) train một mạng tích chập duy nhất, cùng siêu tham số, trên 49 game Atari từ điểm ảnh thô, mỗi game khoảng 50 triệu khung hình; kết quả: ở **29 trong 49 game** nó đạt ít nhất 75% điểm của một người chơi chuyên nghiệp (Hình 3; con số nhớ theo paper, hãy đối chiếu lại). Không làm lại được quy mô đó ở đây. Bản thu nhỏ: **CartPole** thuần NumPy (cho sẵn), mạng MLP của bạn, khoảng **20 000 bước** môi trường, vài chục giây đến hai phút trên CPU, **không cần Internet, không cần GPU**.

**Cho sẵn** (phần "Cho sẵn của paper", bạn không phải viết): hằng `OBS_DIM = 4`, `N_ACTIONS = 2`, `MAX_STEPS = 200`; lớp `CartPole()` với `reset(seed=None) -> obs` và `step(action) -> (obs, reward, done, truncated)` (xem chú thích ở đầu phần cho sẵn: `done` là gậy đổ hoặc xe ra khỏi ray, `truncated` là sống đủ 200 bước); `evaluate(policy_fn, episodes=20, seed=0)` trả return trung bình của một chính sách; `plot_returns(returns)` vẽ đường học. Return tối đa của một episode là 200; chọn hành động ngẫu nhiên thì trung bình chỉ khoảng 20.

**Việc của bạn: một cell code mà chạy xong thì có biến toàn cục `q_net`:** một `QNet` của bạn (trên CPU) đã được train bằng DQN.

| mục | giá trị gợi ý (đổi được, miễn đúng ý) |
|---|---|
| tổng số bước môi trường | 20 000 |
| mạng | `q_net = QNet()`; `target_net = QNet()` rồi chép cứng từ `q_net` lúc đầu |
| optimizer | Adam, learning rate $5 \cdot 10^{-4}$ |
| bộ nhớ | `ReplayBuffer(20000)` (chứa hết mọi bước) |
| batch, $\gamma$ | 64, 0,99 |
| khám phá | $\varepsilon$ giảm tuyến tính từ 1,0 xuống 0,05 trong 5 000 bước đầu, rồi giữ nguyên |
| bắt đầu học | sau 500 bước (buffer chưa đầy dữ liệu thì chưa học) |
| mạng target | chép cứng từ `q_net` mỗi 250 bước |
| mỗi bước môi trường | chọn hành động bằng `select_action`; `step`; cất transition vào buffer; **một** `dqn_train_step`; đến lúc thì `sync_target` |
| giữ bản tốt nhất | mỗi 1 000 bước (sau khi đã bắt đầu học) đo chính sách tham lam của `q_net` bằng `evaluate` trên 5 episode, với seed **riêng** (đừng dùng seed 10 000–10 019 của máy chấm); giữ một bản sao `state_dict()` của lần đo cao nhất (`copy.deepcopy`, vì `state_dict()` trả về chính các tensor đang được train); hết vòng train thì nạp bản đó lại vào `q_net` |
| seed | `torch.manual_seed(...)` và một `np.random.default_rng(...)` truyền cho `select_action`, `dqn_train_step`; môi trường: `reset(seed=...)` ở episode đầu, các episode sau gọi `reset()` |

Hai chi tiết sống còn, đều là loại lỗi **không làm code báo lỗi**:

- Khi cất transition vào buffer, cờ `done` là cờ **kết thúc thật** (`done` của môi trường). Episode bị **cắt** ở bước 200 (`truncated`) thì vẫn phải reset môi trường, nhưng nó **không** phải thất bại: tương lai của trạng thái đó không bằng 0.
- Sau khi episode kết thúc (done hay truncated), gọi `reset()` rồi tiếp tục với trạng thái mới; đừng giữ trạng thái cũ.

**Máy chấm không train lại cho bạn.** Chạy xong cell train thì bấm **Chấm bài**: máy chấm đọc `q_net` đang sống trong kernel, cho nó chơi **chính sách tham lam** (luôn chọn hành động có Q lớn nhất, $\varepsilon = 0$) trên **20 episode mới** (seed riêng, không trùng seed lúc train) và báo:

- `mean_return`: return trung bình trên 20 episode đó. **Đạt khi ≥ 100** (tối đa 200; chính sách ngẫu nhiên ≈ 20).
- `solved_frac`: tỷ lệ episode sống đủ 200 bước (chỉ báo).
- `random_return`: return của chính sách ngẫu nhiên trên cùng 20 seed (chỉ báo; `q_net` phải hơn nó gấp đôi trở lên).
- `q_start`: Q lớn nhất trung bình ở trạng thái đầu episode (chỉ báo; phải hữu hạn và dưới 500).

**Đừng ngạc nhiên nếu kết quả dao động.** DQN nổi tiếng không ổn định: cùng một cấu hình, mỗi seed cho đường học khác nhau, và mạng ở bước cuối có thể đang ở đáy của một đợt dao động. Vì vậy bảng trên có dòng "giữ bản tốt nhất": nộp mạng ở bước cuối thì có thể trượt dù code đúng (lời giải chuẩn của bài này, nộp bước cuối, chỉ đạt khoảng 80). Nếu vẫn thấp, hãy nhìn đường return (`plot_returns`) rồi chạy lại với seed khác.

Lưu ý: `q_net` phải là biến toàn cục của kernel khi bấm Chấm bài (đừng đổi tên, đừng chạy lại cell "Code của bạn từ các bài trước" sau khi train: nó định nghĩa lại các lớp). Giữ mô hình trên CPU.
