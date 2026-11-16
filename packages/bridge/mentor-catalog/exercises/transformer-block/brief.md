Ghép một **transformer block kiểu pre-LN** (như GPT-2) từ các mảnh bạn đã biết. Bài làm bắt đầu từ trang trắng: cell bài làm **không** có sẵn LayerNorm hay attention của các bài trước, bạn tự viết mọi hàm phụ mình cần (`layer_norm`, `attention`, …) **ngay trong cell bài làm**. Máy chấm chỉ gọi hai hàm:

**1. `gelu(x)`** — GELU **xấp xỉ tanh** (chính xác công thức này, không dùng bản `erf`), áp dụng từng phần tử, trả về cùng shape:

$$\operatorname{GELU}(x) = \tfrac12\, x \left(1 + \tanh\!\Big(\sqrt{2/\pi}\,\big(x + 0.044715\, x^3\big)\Big)\right)$$

**2. `transformer_block(x, params, n_heads, causal=False, eps=1e-5)`** — `x` shape `(B, T, D)`, trả về cùng shape:

$$h = x + \operatorname{MHA}\big(\operatorname{LN}_1(x)\big), \qquad y = h + \operatorname{FFN}\big(\operatorname{LN}_2(h)\big), \qquad \operatorname{FFN}(u) = \operatorname{GELU}(u W_1 + b_1)\, W_2 + b_2$$

`params` là dict (mọi mảng float):

| khoá | shape | dùng ở |
|---|---|---|
| `ln1_g`, `ln1_b` | `(D,)` | gamma, beta của $\operatorname{LN}_1$ |
| `Wq`, `Wk`, `Wv`, `Wo` | `(D, D)` | MHA, không bias |
| `ln2_g`, `ln2_b` | `(D,)` | gamma, beta của $\operatorname{LN}_2$ |
| `W1`, `b1` | `(D, F)`, `(F,)` | lớp ẩn của FFN |
| `W2`, `b2` | `(F, D)`, `(D,)` | lớp ra của FFN |

- **LN**: LayerNorm theo **trục cuối** (D), phương sai không hiệu chỉnh, `eps` trong căn: $\gamma \odot (x-\mu)/\sqrt{\sigma^2+\epsilon} + \beta$.
- **MHA**: như bài multi-head attention: $Q = uW_q$ (vector hàng), head `h` dùng các cột `h·d_h … (h+1)·d_h − 1`, softmax của $Q_hK_h^\top/\sqrt{d_h}$, ghép head theo đúng thứ tự cột rồi nhân $W_o$. `n_heads` chia hết `D`. `causal=True`: token `t` chỉ nhìn `s ≤ t`.
- Residual cộng **đầu vào chưa chuẩn hoá** của mỗi sublayer. Không có dropout, không có LayerNorm cuối.
