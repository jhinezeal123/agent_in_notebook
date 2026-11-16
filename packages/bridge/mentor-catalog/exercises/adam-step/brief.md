Cài Adam (Kingma & Ba, 2015) cho một dict tham số `params = {tên: mảng}`:

$$m_t = \beta_1 m_{t-1} + (1-\beta_1) g_t,\qquad v_t = \beta_2 v_{t-1} + (1-\beta_2) g_t^2$$
$$\hat m_t = \frac{m_t}{1-\beta_1^t},\qquad \hat v_t = \frac{v_t}{1-\beta_2^t},\qquad \theta_t = \theta_{t-1} - \eta \frac{\hat m_t}{\sqrt{\hat v_t} + \epsilon}$$

1. `adam_init(params)` trả về trạng thái ban đầu (cấu trúc tuỳ bạn).
2. `adam_step(params, grads, state, lr=1e-3, b1=0.9, b2=0.999, eps=1e-8)` trả về `(new_params, new_state)`.

Bài được chấm bằng cách chạy nhiều bước liên tiếp và so tham số sau mỗi bước.
