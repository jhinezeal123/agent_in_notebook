Viết hai hàm cho **Logistic Regression nhị phân** với phạt L2 (không phạt bias $b$):
$$L(w, b) = \frac{1}{N} \sum_{i=1}^N \big[\log(1 + e^{z_i}) - y_i z_i\big] + \frac{\lambda}{2} \|w\|_2^2, \qquad z = Xw + b.$$

1. `logistic_loss_and_grad(X, y, w, b, lam=0.0)`: trả về `(loss, dw, db)` với `loss` (`float`), `dw` shape $(D,)$, `db` (`float`).
   - **Yêu cầu ổn định số:** Không tràn số hay ra `NaN` ngay cả khi $|z_i| = 1000$ (gợi ý: $\log(1 + e^z) = \operatorname{logaddexp}(0, z)$ và sigmoid ổn định cho cả $z \ge 0$ lẫn $z < 0$).
2. `logistic_step(X, y, w, b, lr=0.1, lam=0.0)`: thực hiện 1 bước gradient descent trả về `(w_new, b_new, loss)`, không sửa `w` tại chỗ.

**Shape vào / ra:** `X` shape $(N, D)$, `y` shape $(N,)$ nhận giá trị $\{0, 1\}$, `w` shape $(D,)$, `b` thực.
