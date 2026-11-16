# %% [markdown]
# **Tách head là chuyện chia cột.** Sau phép chiếu, $Q$ có shape `(T, D)`. Với $H$ head, mỗi head nhận một **dải cột** rộng $d_h = D/H$, và **mọi token** đều có mặt trong mọi head. Hình trái tô màu từng ô của $Q$ theo head mà nó thuộc về.
#
# Bẫy kinh điển: gọi thẳng `reshape(H, T, d_h)`. `reshape` chỉ đọc các số theo thứ tự trong bộ nhớ (hết hàng này sang hàng kia) rồi cắt lại, nó **không biết** trục nào là token, trục nào là feature. Hai hình phải cho thấy "head 0" nhận được gì khi reshape thẳng: ô ở hàng `t` của head 0 thực ra đến từ token nào, cột nào của $Q$?

# %%
import numpy as np
import matplotlib.pyplot as plt

T, D, H = 6, 8, 2
dh = D // H
token_of = np.repeat(np.arange(T)[:, None], D, axis=1)     # ô (t, c) thuộc token t
col_of = np.repeat(np.arange(D)[None, :], T, axis=0)       # ô (t, c) là cột c
head_of = col_of // dh                                     # head đúng của ô đó

naive_token = token_of.reshape(H, T, dh)[0]
naive_col = col_of.reshape(H, T, dh)[0]

fig, ax = plt.subplots(1, 3, figsize=(13, 3.6))
ax[0].imshow(head_of, cmap="tab10", vmin=0, vmax=9)
ax[0].set_title("Q (T×D): màu = head đúng của ô")
ax[0].set_xlabel("cột (feature)")
ax[0].set_ylabel("token")
ax[1].imshow(naive_token, cmap="viridis")
ax[1].set_title("reshape thẳng, head 0:\nô này đến từ token nào?")
ax[2].imshow(naive_col, cmap="viridis")
ax[2].set_title("reshape thẳng, head 0:\nô này đến từ cột nào?")
for a, grid in [(ax[1], naive_token), (ax[2], naive_col)]:
    for (r, c), v in np.ndenumerate(grid):
        a.text(c, r, str(v), ha="center", va="center", color="w", fontsize=9)
    a.set_xlabel("cột trong head")
    a.set_ylabel("'token' trong head")
plt.tight_layout()
plt.show()

# %% [markdown]
# Head 0 lẽ ra là: hàng `t` = token `t`, cột = `0 … d_h−1`. Reshape thẳng trộn token với feature. Hãy nghĩ: muốn tách trục `D` thành `(H, d_h)` mà **không đụng** trục token thì reshape thành shape nào, rồi đưa trục head ra trước bằng phép gì? Lúc ghép lại thì làm ngược đúng thứ tự đó.
#
# **Scale bằng gì?** Mỗi head làm attention trong không gian $d_h$ chiều, không phải $D$. Thí nghiệm: với $D = 512$ cố định, tăng số head; điểm $q\cdot k$ của một head có độ lệch chuẩn $\sqrt{d_h}$. Chia cho $\sqrt{D}$ thì điểm quá nhỏ và softmax gần như **đều** (entropy gần cực đại $\log T$), head mất khả năng tập trung.

# %%
rng = np.random.default_rng(0)
D_big, T_big = 512, 32
heads = [1, 2, 4, 8, 16, 32]

def row_entropy(scores):
    s = scores - scores.max(-1, keepdims=True)
    p = np.exp(s)
    p /= p.sum(-1, keepdims=True)
    return float(-(p * np.log(p + 1e-12)).sum(-1).mean())

ent_dh, ent_D = [], []
for h in heads:
    d_head = D_big // h
    q = rng.normal(size=(T_big, d_head))
    k = rng.normal(size=(T_big, d_head))
    s = q @ k.T
    ent_dh.append(row_entropy(s / np.sqrt(d_head)))
    ent_D.append(row_entropy(s / np.sqrt(D_big)))

plt.figure(figsize=(6, 3.4))
plt.plot(heads, ent_dh, "o-", label="chia √d_h")
plt.plot(heads, ent_D, "s--", label="chia √D")
plt.axhline(np.log(T_big), color="gray", lw=0.8, ls=":", label="log T (softmax đều)")
plt.xscale("log", base=2)
plt.xlabel("số head H (D = 512)")
plt.ylabel("entropy trung bình mỗi hàng")
plt.legend()
plt.title("Scale sai làm attention nhoè dần khi H tăng")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Bảng shape** để điền khi phác thảo (B batch, T token, H head, d_h = D/H):

# %%
rows = [
    ("x", "(B, T, D)"),
    ("Q = x @ Wq", "(B, T, D)"),
    ("tách trục D", "(B, T, H, d_h)"),
    ("đưa head ra trước", "(B, H, T, d_h)"),
    ("điểm / weights", "(B, H, T, T)"),
    ("weights @ V", "(B, H, T, d_h)"),
    ("ghép head", "(B, T, D)"),
    ("out = ghép @ Wo", "(B, T, D)"),
]
for name, shape in rows:
    print(f"{name:>20}: {shape}")
