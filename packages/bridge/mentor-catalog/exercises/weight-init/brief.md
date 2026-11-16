Khởi tạo ma trận trọng số `W` của một lớp dense `y = x @ W`, với `W` shape **`(fan_in, fan_out)`** (chú ý: `nn.Linear` của PyTorch lưu ngược lại, `(out, in)`). Trung bình luôn bằng 0; điều cần đúng là **phương sai**:

| Hàm | Phân phối | Phương sai mục tiêu |
|---|---|---|
| `xavier_normal(fan_in, fan_out, rng)` | chuẩn $\mathcal N(0, \sigma^2)$ | $\operatorname{Var}(W) = \dfrac{2}{\text{fan\_in} + \text{fan\_out}}$ |
| `xavier_uniform(fan_in, fan_out, rng)` | đều $\mathcal U(-a, a)$ | như trên |
| `kaiming_normal(fan_in, fan_out, rng)` | chuẩn $\mathcal N(0, \sigma^2)$ | $\operatorname{Var}(W) = \dfrac{2}{\text{fan\_in}}$ (cho ReLU, mode `fan_in`) |
| `kaiming_uniform(fan_in, fan_out, rng)` | đều $\mathcal U(-a, a)$ | như trên |

- Với hai bản **uniform**, bạn tự suy ra cận $a$ sao cho phương sai đúng bằng mục tiêu.
- Mọi số ngẫu nhiên phải lấy từ `rng` (một `np.random.Generator` được truyền vào), không dùng `np.random.*` toàn cục, để cùng seed thì ra cùng ma trận.
- Trả về mảng float shape `(fan_in, fan_out)`.

Bài được chấm bằng thống kê trên ma trận lớn: trung bình, độ lệch chuẩn, cận, và hình dạng phân phối (chuẩn hay đều).
