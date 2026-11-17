Viết hàm loss **NT-Xent** (*normalized temperature-scaled cross entropy*) của **SimCLR** (Chen et al., 2020, *A Simple Framework for Contrastive Learning of Visual Representations*), dạng đặc biệt của InfoNCE: `nt_xent(z1, z2, temperature=0.5)`.

Ý tưởng: lấy $N$ ảnh, mỗi ảnh biến đổi ngẫu nhiên hai lần (hai "view": cắt, đổi màu, ...). Hai view của **cùng một ảnh** phải có embedding giống nhau; view của **ảnh khác** phải khác. Loss kéo cặp "positive" lại gần và đẩy mọi cặp còn lại ra xa, không cần nhãn nào.

- `z1`, `z2`: tensor số thực shape `(N, D)`; `z1[i]` và `z2[i]` là embedding của hai view của ảnh `i` (đầu ra của encoder, **chưa chuẩn hóa**, độ dài tùy ý).
- `temperature` $\tau > 0$.
- Trả về một **số** (tensor 0 chiều).

Ghép thành $2N$ vector: $z_0, \dots, z_{N-1}$ là `z1` rồi $z_N, \dots, z_{2N-1}$ là `z2`. Chuẩn hóa $L_2$ từng vector, $\hat z_i = z_i / \lVert z_i \rVert$, rồi đo độ giống bằng cosine chia $\tau$:

$$s_{ij} = \frac{\hat z_i \cdot \hat z_j}{\tau}$$

Positive của $i$ là $p(i)$: view còn lại của cùng ảnh, tức $i + N$ nếu $i < N$ và $i - N$ nếu $i \ge N$. Mọi vector khác ($k \ne i$, $k \ne p(i)$) là negative. Loss của $i$ và loss cả batch:

$$\ell_i = -\log \frac{\exp(s_{i,p(i)})}{\sum_{k \ne i} \exp(s_{ik})}, \qquad \mathcal{L} = \frac{1}{2N}\sum_{i=0}^{2N-1} \ell_i$$

Chú ý tổng ở mẫu số chạy qua mọi $k \ne i$: có $2N - 1$ số hạng (gồm cả positive), **không** có $k = i$ (một vector luôn giống chính nó nhất, không mang thông tin).

Ràng buộc:

- Phải chạy được với $N = 1$ (khi đó mỗi hàng chỉ có positive).
- Phải **ổn định số** với $\tau$ nhỏ, ví dụ $\tau = 0.01$ (khi đó $s_{ij}$ lên tới 100 và $e^{100}$ tràn float32) và với embedding rất dài. Được dùng `F.cross_entropy`, `F.normalize`.
- Gradient phải chảy về **cả** `z1` và `z2`.
- Không sửa `z1`, `z2` tại chỗ. Không vòng lặp Python theo mẫu.

Trước khi code, tự trả lời: nếu mọi embedding đều **giống hệt nhau**, các $s_{ik}$ bằng nhau, vậy $\ell_i$ bằng bao nhiêu theo $N$ (và có phụ thuộc $\tau$ không)? Còn nếu quên loại $k = i$ khỏi mẫu số thì con số đó đổi thế nào?
