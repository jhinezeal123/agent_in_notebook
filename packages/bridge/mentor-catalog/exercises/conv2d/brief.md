Viết `conv2d(x, w, b, stride=1, padding=0)`: lớp convolution 2D **như trong deep learning** (tức là *cross-correlation*, kernel **không** bị lật, giống `torch.nn.functional.conv2d`).

- `x` shape `(N, C_in, H, W)`, `w` shape `(C_out, C_in, kH, kW)`, `b` shape `(C_out,)`.
- `stride` (số nguyên ≥ 1) và `padding` (số nguyên ≥ 0) dùng chung cho chiều cao và chiều rộng. Padding là **zero padding**: thêm `padding` ô số 0 vào **mỗi** phía của H và W (không đụng tới trục N, C).
- Trả về mảng `(N, C_out, H_out, W_out)` với

$$H_\text{out} = \left\lfloor \frac{H + 2p - k_H}{s} \right\rfloor + 1, \qquad W_\text{out} = \left\lfloor \frac{W + 2p - k_W}{s} \right\rfloor + 1$$

$$\text{out}[n, f, i, j] = b_f + \sum_{c=0}^{C_\text{in}-1} \sum_{u=0}^{k_H-1} \sum_{v=0}^{k_W-1} w[f, c, u, v]\; \tilde{x}[n, c,\; s\,i + u,\; s\,j + v]$$

trong đó $\tilde{x}$ là `x` sau khi pad. Mỗi kênh ra `f` có **một** bias $b_f$, cộng đúng một lần.

- Kernel có thể không vuông (`kH ≠ kW`), ảnh có thể không vuông.
- Chỉ dùng numpy. Bốn vòng `for` lồng nhau theo `(n, f, i, j)` chạy được nhưng chậm; hãy thử vectorise: hoặc lặp theo các offset `(u, v)` của kernel (chỉ `kH·kW` vòng), hoặc dựng ma trận im2col rồi nhân một lần.
