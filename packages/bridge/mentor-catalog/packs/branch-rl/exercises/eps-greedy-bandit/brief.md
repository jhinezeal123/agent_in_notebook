Viết ba hàm cho một **bandit K tay** học bằng **epsilon-greedy**: `select_action(q, eps, rng)` chọn tay, `update(q, n, a, r)` cập nhật ước lượng sau khi nhận thưởng, và `run_bandit(rewards, eps, rng)` ráp hai hàm đó thành cả một lượt chơi.

Bandit: có $K$ tay. Mỗi lượt bạn kéo một tay $a$ và nhận thưởng $r$. Bạn không biết tay nào tốt, nên giữ một **ước lượng giá trị** $Q_a$ cho từng tay (trung bình các phần thưởng đã nhận từ tay đó) và $N_a$ (số lần đã kéo).

**`select_action(q, eps, rng)`**

- Với xác suất $\varepsilon$: **khám phá**, chọn một tay **đều ngẫu nhiên trong cả $K$ tay** (kể cả tay đang tốt nhất). Với xác suất $1-\varepsilon$: **khai thác**, chọn tay có $Q$ lớn nhất.
- Nhiều tay cùng bằng giá trị lớn nhất (đồng hạng chính xác, ví dụ lúc đầu mọi $Q = 0$): chọn **ngẫu nhiên đều** giữa các tay đó, không luôn lấy tay đầu tiên.
- `eps = 0` là greedy thuần (không bao giờ khám phá); `eps = 1` là chọn ngẫu nhiên đều.
- `q`: `np.ndarray` float shape `(K,)`. `rng`: `numpy.random.Generator` (do người gọi truyền vào). **Mọi** lựa chọn ngẫu nhiên phải đi qua `rng`, không dùng `np.random.*` toàn cục, để cùng một seed cho cùng một kết quả.
- Trả về chỉ số tay: một số nguyên Python (hoặc numpy) trong `[0, K)`. Không sửa `q`.

**`update(q, n, a, r)`**: sau khi kéo tay `a` và nhận thưởng `r`, cập nhật **trung bình cộng** theo dạng tăng dần, không lưu lại lịch sử phần thưởng:

$$N_a \leftarrow N_a + 1,\qquad Q_a \leftarrow Q_a + \frac{1}{N_a}\,\big(r - Q_a\big)$$

- `q`: float `(K,)`, `n`: số nguyên `(K,)` (số lần kéo của từng tay). Cả hai được **sửa tại chỗ**; hàm không cần trả về gì. Chỉ phần tử của tay `a` thay đổi.
- Lúc đầu $N_a = 0$: phần thưởng đầu tiên phải làm $Q_a$ bằng đúng $r$ (giá trị khởi tạo bị quên hẳn), và $Q_a$ luôn bằng trung bình cộng mọi phần thưởng của tay `a`. Để ý **thứ tự**: $N_a$ trong công thức là số lần kéo *tính cả lần này*.

**`run_bandit(rewards, eps, rng)`**

- `rewards`: `np.ndarray` shape `(steps, K)`, **bảng thưởng đã bốc sẵn**: kéo tay `a` ở lượt `t` thì nhận `rewards[t, a]`. (Bảng cố định giúp bài kiểm tất định.)
- Bắt đầu với $Q = 0$ (float) và $N = 0$ (số nguyên). Ở mỗi lượt `t = 0..steps-1`: chọn tay bằng `select_action` của bạn, nhận thưởng, gọi `update` của bạn.
- Trả về bộ ba `(q, n, actions)`: `q` float `(K,)`, `n` int `(K,)`, `actions` int64 `(steps,)` là tay đã chọn ở từng lượt.

Chỉ cần NumPy. Test không train gì, chỉ chạy bandit nhỏ với seed cố định.
