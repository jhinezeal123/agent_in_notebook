**Biến thể của cross-entropy.** Label smoothing (Szegedy et al., 2016) không bắt mô hình tin 100% vào nhãn đúng: nhãn one-hot được thay bằng một phân phối "mềm" trên cả $C$ lớp,

$$q_c = (1 - \varepsilon)\,[c = y] + \frac{\varepsilon}{C} \qquad (\text{chia đều } \varepsilon \text{ cho cả } C \text{ lớp, kể cả lớp đúng}),$$

$$\text{loss} = \frac{1}{B}\sum_{b=1}^{B} \Big( -\sum_{c=1}^{C} q_{b,c}\, \log \operatorname{softmax}(z_b)_c \Big).$$

Như vậy lớp đúng nhận $1 - \varepsilon + \varepsilon/C$, mỗi lớp sai nhận $\varepsilon/C$ (giống `F.cross_entropy(..., label_smoothing=ε)` của PyTorch).

Viết `smoothed_cross_entropy(logits, targets, eps=0.1)`:

- `logits` shape `(B, C)`, `targets` shape `(B,)` số nguyên; trả về một số thực (trung bình trên batch).
- Với `eps = 0` phải ra đúng cross-entropy thường.
- **Ổn định số**: logits cỡ `1000` không được sinh ra `inf` hay `nan`. Không dùng `scipy`.
