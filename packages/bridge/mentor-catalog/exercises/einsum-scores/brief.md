Viết hai hàm, mỗi hàm **một dòng `np.einsum`**:

1. `batched_scores(Q, K)`: `Q` shape `(B, H, T, d)`, `K` shape `(B, H, S, d)` → `(B, H, T, S)` với
   $\text{scores}_{bhts} = \sum_k Q_{bhtk} K_{bhsk}$ (tức là $QK^\top$ cho từng batch và từng head).
2. `bilinear(x, W, y)`: `x` shape `(B, n)`, `W` shape `(n, m)`, `y` shape `(B, m)` → `(B,)` với
   $\text{out}_b = x_b^\top W y_b$.

Lưu ý `T` và `S` có thể khác nhau.
