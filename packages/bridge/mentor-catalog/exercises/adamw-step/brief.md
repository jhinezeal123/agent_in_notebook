**Biến thể của Adam.** AdamW (Loshchilov & Hutter, 2019) **tách weight decay ra khỏi gradient**: $\lambda\theta$ không được cộng vào $g_t$ (nên không đi qua $m$, $v$ và không bị chia cho $\sqrt{\hat v}$), mà được trừ thẳng vào tham số. Quy ước dùng trong bài này giống `torch.optim.AdamW`:

$$m_t = \beta_1 m_{t-1} + (1-\beta_1) g_t,\qquad v_t = \beta_2 v_{t-1} + (1-\beta_2) g_t^2,\qquad \hat m_t = \frac{m_t}{1-\beta_1^t},\quad \hat v_t = \frac{v_t}{1-\beta_2^t}$$

$$\theta_t = \theta_{t-1} - \eta\left(\frac{\hat m_t}{\sqrt{\hat v_t} + \epsilon} + \lambda\,\theta_{t-1}\right)$$

- $g_t$ là gradient của loss **không** có số hạng decay.
- Decay dùng $\theta_{t-1}$ (giá trị **trước** bước này) và **có nhân** $\eta$. Viết tách hai bước cũng được: $\theta \leftarrow \theta(1 - \eta\lambda)$ rồi trừ phần Adam; kết quả như nhau vì phần Adam không phụ thuộc $\theta$.

Viết:

1. `adamw_init(params)` trả về trạng thái ban đầu (cấu trúc tuỳ bạn).
2. `adamw_step(params, grads, state, lr=1e-3, b1=0.9, b2=0.999, eps=1e-8, wd=1e-2)` trả về `(new_params, new_state)`; `params`, `grads` là dict `{tên: mảng}` như bài Adam.

Bài được chấm bằng cách chạy nhiều bước liên tiếp và so tham số sau mỗi bước.
