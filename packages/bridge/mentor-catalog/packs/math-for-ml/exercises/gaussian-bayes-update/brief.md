Xét mô hình liên hợp Normal–Normal cho tham số trung bình chưa biết $\theta$:
- Tiên nghiệm (prior): $\theta \sim \mathcal{N}(\mu_0, \sigma_0^2)$ với phương sai tiên nghiệm `var0 > 0`.
- Quan sát i.i.d.: $x_1, \dots, x_n \mid \theta \sim \mathcal{N}(\theta, \sigma^2)$ với phương sai nhiễu đã biết `obs_var > 0`.

Viết hai hàm:
1. `posterior_normal(x, mu0, var0, obs_var)`: trả về tuple `(mu_post, var_post)` (hai số `float`) của phân bố hậu nghiệm $\theta \mid x_{1:n} \sim \mathcal{N}(\mu_n, \sigma_n^2)$:
   $$\frac{1}{\sigma_n^2} = \frac{1}{\sigma_0^2} + \frac{n}{\sigma^2}, \qquad \mu_n = \sigma_n^2 \left( \frac{\mu_0}{\sigma_0^2} + \frac{\sum_{i=1}^n x_i}{\sigma^2} \right).$$
2. `predictive_normal(x, mu0, var0, obs_var)`: trả về tuple `(mu_pred, var_pred)` (hai số `float`) của phân bố tiên đoán hậu nghiệm cho một quan sát mới $x_{\text{new}} \mid x_{1:n}$.

**Ca biên:** `x` là mảng 1D (có thể rỗng $n = 0$: khi đó hậu nghiệm trùng khít với tiên nghiệm).
