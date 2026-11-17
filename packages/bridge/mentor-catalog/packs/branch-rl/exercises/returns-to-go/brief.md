Viết `returns_to_go(rewards, gamma, dones=None)`: với mỗi bước $t$, tính **return còn lại** (reward-to-go) $G_t$, tổng thưởng từ bước $t$ trở đi, mỗi bước xa hơn bị nhân thêm một lần $\gamma$. Đây là "tín hiệu học" của mọi thuật toán policy gradient: bài `reinforce-loss` sau đó nhân nó với log-xác suất của hành động.

$$G_t = r_t + \gamma\, r_{t+1} + \gamma^2 r_{t+2} + \dots = r_t + \gamma\, G_{t+1}$$

Dòng thứ hai là quan hệ truy hồi: biết $G_{t+1}$ thì $G_t$ ra ngay.

**Nhiều episode nối tiếp.** Trong thực tế bạn chơi nhiều episode liên tiếp rồi nối thưởng của chúng thành một mảng dài. Cờ `dones` đánh dấu **bước cuối của mỗi episode**: `dones[t]` khác 0 nghĩa là sau bước $t$ episode kết thúc, và thưởng của bước $t+1$ trở đi thuộc episode **khác**, không được cộng vào $G_t$. Tức là ở bước $t$ có `dones[t]` thì $G_t = r_t$.

**Vào/ra**

- `rewards`: mảng (hoặc list) số, shape `(T,)`. Có thể là số nguyên.
- `gamma`: số thực trong `[0, 1]`.
- `dones`: `None` (cả mảng là **một** episode), hoặc mảng `(T,)` kiểu bool hoặc 0/1.
- Trả về `np.ndarray` **số thực** (float) shape `(T,)`, `G[t]` là return còn lại của bước $t$.

**Lưu ý**

- Bước cuối của mảng (`t = T - 1`) mà không có `done`: episode bị cắt ngang. Bài này **không** bootstrap gì thêm: $G_{T-1} = r_{T-1}$. (Cắt ngang mà vẫn muốn ước lượng phần còn lại là việc của bài `gae`.)
- Không sửa `rewards` và `dones` của người gọi. `T = 0` trả về mảng rỗng.
- Chỉ cần NumPy. Hàm này chạy trên dữ liệu thu thập từ môi trường, không cần gradient: ở bài sau, bạn sẽ đổi kết quả sang tensor.

Máy chấm kiểm: một ví dụ tính tay, các giá trị biên của `gamma`, ranh giới episode, đoạn cuối bị cắt, dạng của `dones`, khớp lời giải chuẩn trên dữ liệu ngẫu nhiên, kiểu dữ liệu (float dù đầu vào là số nguyên) và việc không sửa đầu vào.
