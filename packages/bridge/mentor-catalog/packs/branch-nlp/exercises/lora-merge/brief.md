**Biến thể của `lora-linear`.** Lúc huấn luyện, LoRA giữ $W$ và $(A, B)$ tách rời để chỉ học phần nhỏ. Lúc **suy luận** thì không cần tách nữa: độ lệch hạng thấp có thể **gộp** thẳng vào trọng số gốc, và mô hình chạy y hệt một mô hình thường, không tốn thêm phép tính nào. Bài bạn viết hàm gộp đó. Trước khi code, hãy trả lời câu dự đoán đi kèm bài.

**`merge(lora)`**: `lora` là một `LoRALinear` (bài `lora-linear` của bạn đã định nghĩa class này: dùng các thuộc tính `base`, `A`, `B`, `scale` của nó). Trả về một **`nn.Linear` thường** (không phải `LoRALinear`) $y = x\,W'^\top + b$ sao cho với mọi $x$:

$$\text{merged}(x) = \operatorname{lora}(x) \qquad\text{với}\qquad W' = W + \frac{\alpha}{r}\,B A$$

- `merged` có `in_features` và `out_features` như `lora.base`; `merged.weight` có shape `(out, in)`. Bias như cũ: `lora.base` có bias thì `merged` có bias bằng đúng giá trị đó, không có thì `merged.bias` là `None`.
- Hàm này **không được sửa** `lora`: sau khi gộp, `lora.base.weight`, `lora.base.bias`, `lora.A`, `lora.B` phải y nguyên và `lora` vẫn cho đúng đầu ra cũ. Bản gộp phải là một lớp **độc lập**: sửa trọng số của `merged` không được làm đổi `lora.base`.
- Bản gộp dùng để **suy luận**: mọi tham số của nó có `requires_grad = False`, và nó không dính đồ thị tính toán của `A`, `B` (`merged(x)` với `x` không cần gradient thì không cần gradient; không có `grad_fn` nào lòi ra từ `weight`).
- `merged` chỉ còn các tham số của một `nn.Linear` thường: số tham số bằng của `lora.base`, không còn `A`, `B`.
