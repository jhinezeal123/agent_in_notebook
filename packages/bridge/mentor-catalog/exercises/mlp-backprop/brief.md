Một MLP hai lớp với ReLU:

$$z_1 = XW_1 + b_1,\quad h = \operatorname{ReLU}(z_1),\quad \text{out} = hW_2 + b_2$$

`params` là dict `{"W1": (D, H), "b1": (H,), "W2": (H, O), "b2": (O,)}`, `X` shape `(B, D)`.

1. `mlp_forward(X, params)` trả về `(out, cache)`; `cache` là gì tuỳ bạn (thứ backward cần).
2. `mlp_backward(dout, cache, params)` nhận $\partial L/\partial \text{out}$ shape `(B, O)` và trả về dict gradient `{"W1", "b1", "W2", "b2"}`, mỗi cái **cùng shape** với tham số tương ứng.

Không dùng autograd của thư viện nào. Bài làm được kiểm bằng gradient số (sai phân hữu hạn), nên hãy tự kiểm như vậy trước khi chấm.
