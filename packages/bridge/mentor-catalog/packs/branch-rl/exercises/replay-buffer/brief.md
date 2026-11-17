Viết lớp `ReplayBuffer(capacity)`: **bộ nhớ trải nghiệm** của DQN. Agent chơi, mỗi bước cất một *transition* $(s, a, r, s', \text{done})$ vào bộ đệm; lúc học thì bốc một **batch ngẫu nhiên** ra để cập nhật mạng. Vì bộ nhớ có hạn, bộ đệm là một **vòng tròn**: đầy thì transition mới ghi đè transition **cũ nhất**. Bài chạy bằng NumPy thuần.

**Giao diện** (tên thuộc tính bên trong tùy bạn, test chỉ dùng ba phương thức này):

- `ReplayBuffer(capacity)`: `capacity` là số nguyên $\ge 1$, số transition tối đa.
- `push(s, a, r, s_next, done)`: thêm một transition.
  - `s`, `s_next`: vector 1 chiều shape `(d,)`; `d` suy ra từ lần `push` đầu tiên. `a`: số nguyên. `r`: số thực. `done`: bool.
  - **Lưu bản sao** của dữ liệu: người gọi thường dùng lại một mảng `s` rồi sửa tại chỗ ở bước sau; bộ đệm không được giữ tham chiếu tới mảng của họ.
  - Đầy rồi thì ghi đè transition **cũ nhất** (cái được push sớm nhất còn trong bộ đệm). Transition mới luôn vào được.
- `sample(batch_size, rng)`: bốc ngẫu nhiên **đều, không thay thế** `batch_size` transition khác nhau trong số **đã ghi** (không bao giờ lấy ô còn trống). `rng` là `numpy.random.Generator` do người gọi truyền vào; mọi lựa chọn ngẫu nhiên phải đi qua nó. Trả về bộ năm mảng NumPy, **hàng thứ $i$ của mọi mảng thuộc về cùng một transition**:

| mảng | shape | dtype |
|---|---|---|
| `states` | `(B, d)` | `float32` |
| `actions` | `(B,)` | `int64` |
| `rewards` | `(B,)` | `float32` |
| `next_states` | `(B, d)` | `float32` |
| `dones` | `(B,)` | `float32` (1.0 nếu `done`, 0.0 nếu không) |

  Đúng dtype như bảng, bất kể kiểu của đầu vào (int32, bool, float64…): các mảng này sẽ đi thẳng vào mạng nơ-ron ở bài `dqn-td-loss`. `batch_size < 1` hoặc lớn hơn số transition đang có (kể cả bộ đệm trống): `raise ValueError`.
- `len(buffer)` (`__len__`): số transition đang có, bằng `min(số lần push, capacity)`.

Máy chấm kiểm: `len` ở mọi giai đoạn, shape và dtype, các cột không bị lệch hàng, ghi đè đúng cái cũ nhất qua nhiều vòng, không lặp trong một batch, không lấy ô trống, lỗi khi bốc quá nhiều, bản sao dữ liệu, tính đều của việc bốc và việc dùng `rng` truyền vào.

Chỉ cần NumPy, không cần PyTorch.
