Viết hai hàm:

1. `log_softmax(z, axis=-1)`: trả về $\log \operatorname{softmax}(z)$ theo trục `axis`, cùng shape với `z`.
2. `cross_entropy(logits, targets)`: `logits` shape `(B, C)`, `targets` shape `(B,)` số nguyên → **trung bình** trên batch của $-\log \operatorname{softmax}(z_b)_{y_b}$.

Cả hai phải **ổn định số**: logits cỡ `1000` không được sinh ra `inf` hay `nan`. Không dùng `scipy`.
