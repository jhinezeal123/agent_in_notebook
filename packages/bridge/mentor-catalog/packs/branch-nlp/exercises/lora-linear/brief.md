Viết **LoRA** (Hu et al., 2021, *LoRA: Low-Rank Adaptation of Large Language Models*): thay vì fine-tune cả một ma trận trọng số $W$ khổng lồ, **đóng băng** $W$ và chỉ học một độ lệch hạng thấp $\Delta W = \frac{\alpha}{r} B A$ cộng vào nó. Bạn viết `class LoRALinear(nn.Module)` bọc một `nn.Linear` có sẵn.

**`LoRALinear(base, r=4, alpha=8.0)`**: `base` là một `nn.Linear(in, out)` (có hoặc không có bias) đã được tạo sẵn và đã có trọng số. Với đầu vào $x$ có shape `(..., in)`:

$$y = \operatorname{base}(x) + \frac{\alpha}{r}\; x A^\top B^\top \qquad\Longleftrightarrow\qquad y = x\Big(W + \tfrac{\alpha}{r} B A\Big)^\top + b$$

| thuộc tính | là gì |
|---|---|
| `base` | chính `nn.Linear` được truyền vào, **đóng băng**: `weight` và `bias` (nếu có) đều `requires_grad = False` |
| `A` | `nn.Parameter` shape `(r, in)`, khởi tạo **ngẫu nhiên nhỏ**: phân phối chuẩn (hoặc đều) có độ lệch chuẩn cỡ $1/\sqrt{\text{in}}$ |
| `B` | `nn.Parameter` shape `(out, r)`, khởi tạo **toàn số 0** |
| `scale` | số thực (không phải tham số) bằng $\alpha / r$ |

- Đầu ra có cùng shape với `base(x)`: `(..., out)`. `x` có thể là `(in,)`, `(N, in)`, `(B, T, in)` hay nhiều chiều hơn.
- Ngay sau khi khởi tạo, `LoRALinear` phải cho **đúng cùng đầu ra** với `base`: thêm adapter không được làm đổi mô hình lúc xuất phát.
- Trong `module.parameters()`, chỉ `A` và `B` cần gradient. Số tham số học được là $r\,(\text{in} + \text{out})$, nhỏ hơn rất nhiều so với $\text{in}\cdot\text{out}$ của $W$.
- Huấn luyện không được làm đổi `base`: sau một bước optimizer, `base.weight` và `base.bias` phải y nguyên.
- Máy chấm chép trọng số theo tên tham số trong `state_dict()`, nên giữ đúng bốn tên `base`, `A`, `B`, `scale` (tham số của module sẽ có tên `base.weight`, `base.bias`, `A`, `B`). Nhớ gọi `super().__init__()` trước khi gán bất cứ thứ gì vào `self`.

Trước khi code, hãy tự trả lời: vì sao $B$ khởi tạo bằng 0 mà $A$ thì không? Nếu cả hai cùng bằng 0, điều gì xảy ra với gradient?
