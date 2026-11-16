Một lớp embedding là một bảng `W` shape `(V, d)`: hàng thứ $i$ là vector của token có id $i$. Viết hai hàm:

1. `embedding_forward(ids, W)`: `ids` là mảng số nguyên **shape bất kỳ** (vô hướng, `(N,)`, `(B, T)`, …). Trả về mảng shape `ids.shape + (d,)` với

$$\text{out}[p] = W[\text{ids}[p]] \quad \text{với mọi vị trí } p$$

   Nếu có id nào nằm ngoài $[0, V)$ (kể cả id âm) thì **raise `IndexError`**, đừng để nó lặng lẽ lấy nhầm hàng.

2. `embedding_backward(ids, grad_out, V)`: `grad_out` là $\partial L/\partial\,\text{out}$, shape `ids.shape + (d,)`. Trả về $\partial L/\partial W$ shape `(V, d)`:

$$\frac{\partial L}{\partial W_i} = \sum_{p\,:\,\text{ids}[p] = i} \text{grad\_out}[p]$$

   Hàng của token không xuất hiện bằng 0. Một id xuất hiện **nhiều lần** (trong cùng câu hay ở câu khác) thì gradient của mọi lần xuất hiện phải **cộng dồn**.

Tránh vòng lặp Python trên từng token nếu được; bài được chấm trên dữ liệu có nhiều id lặp lại.
