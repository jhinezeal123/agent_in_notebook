**Biến thể của `gpt-generate`.** Ở bài gốc, temperature chỉ là một phép chia nằm giữa logits và softmax, và đề cố ý bỏ qua `temperature = 0`. Bài này mở phép chia đó ra: bạn tách riêng hai hàm, một để **biến logits thành phân phối theo temperature** (kể cả hai ca biên mà phép chia gãy), một để **đo độ ngẫu nhiên của phân phối** bằng entropy. Trước khi code, hãy trả lời câu dự đoán đi kèm bài.

**`temperature_probs(logits, temperature)`**: với `temperature` $\tau > 0$,

$$p_i = \frac{e^{z_i/\tau}}{\sum_j e^{z_j/\tau}}$$

- `logits` $z$: tensor số thực shape `(..., V)` (ví dụ `(B, V)` hoặc `(B, T, V)`); softmax theo **trục cuối**. Trả về tensor **cùng shape**, mỗi hàng cộng thành 1.
- `temperature = 0` là **giới hạn $\tau \to 0^+$**: toàn bộ xác suất dồn vào token có logit lớn nhất (one-hot, cùng kiểu số thực với `logits`). Nó không được ra `nan` hay `inf`. Test không có hàng nào có hai logit lớn nhất bằng nhau.
- `temperature < 0` thì `raise ValueError`.
- Logit có thể bằng $-\infty$ (token đã bị che, như sau top-k); mỗi hàng có ít nhất một logit hữu hạn. Token bị che phải có xác suất đúng 0.
- Phải ổn định số với logits rất lớn (hàng trăm, hàng nghìn) và với `temperature` rất nhỏ (như $10^{-6}$).
- Không sửa `logits` của người gọi tại chỗ.

**`entropy(probs)`**: entropy Shannon theo **nat** (logarit tự nhiên) của từng phân phối:

$$H(p) = -\sum_{i} p_i \ln p_i, \qquad 0 \ln 0 := 0$$

- `probs` shape `(..., V)`, mỗi hàng là một phân phối (có thể có phần tử bằng đúng 0). Trả về tensor shape `(...)`: bỏ trục cuối.
- Phân phối có phần tử bằng 0 phải cho giá trị hữu hạn đúng, không ra `nan`.
