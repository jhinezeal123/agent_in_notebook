# %% [markdown]
# **Chuỗi mà Transformer thấy.** Sau patch embedding, ảnh là $N$ token. ViT thêm **một token đặc biệt `cls`** vào đầu chuỗi (nó không đến từ pixel nào, chỉ là một vector học được), rồi cộng vào mỗi vị trí một **positional embedding** học được. Hình dưới vẽ chuỗi cho $N = 6$: hàng trên là các token, hàng dưới là positional embedding của từng vị trí. Hãy đếm: chuỗi có bao nhiêu token, positional embedding cần bao nhiêu hàng, và cần dùng hàng nào cho token `cls`? Sau cùng mô hình đọc kết quả từ token nào?

# %%
import numpy as np
import matplotlib.pyplot as plt

N = 6
labels = ["cls"] + [f"patch {i}" for i in range(N)]
fig, ax = plt.subplots(figsize=(8.4, 2.9))
for i, name in enumerate(labels):
    ax.add_patch(plt.Rectangle((i * 1.1, 1.2), 1.0, 0.9, fc="tab:red" if i == 0 else "tab:blue", alpha=0.75))
    ax.text(i * 1.1 + 0.5, 1.65, name, ha="center", va="center", color="white", fontsize=8, fontweight="bold")
    ax.add_patch(plt.Rectangle((i * 1.1, 0.0), 1.0, 0.7, fc="tab:green", alpha=0.6))
    ax.text(i * 1.1 + 0.5, 0.35, f"pos {i}", ha="center", va="center", fontsize=8)
    ax.text(i * 1.1 + 0.5, 0.95, "+", ha="center", va="center", fontsize=12)
ax.set_xlim(-0.2, len(labels) * 1.1 + 0.1); ax.set_ylim(-0.2, 2.4); ax.axis("off")
ax.set_title("token (trên) cộng positional embedding (dưới), cùng chiều dim", fontsize=9)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Vì sao cần positional embedding?** Self-attention coi chuỗi như một **tập hợp**: nếu ta đảo thứ tự các token đầu vào, đầu ra chỉ bị đảo thứ tự theo, không có số nào đổi giá trị. Hình dưới thử với một lớp self-attention một đầu viết bằng numpy (trọng số ngẫu nhiên) trên 7 token: đo sai khác giữa "đảo rồi attention" và "attention rồi đảo". Cột trái: không có positional embedding. Cột phải: có positional embedding gắn theo **vị trí** (không theo token). Trục tung là thang log; hãy nhìn cột nào gần máy epsilon (≈1e-16), từ đó trả lời trước khi code: nếu thiếu positional embedding, mô hình có phân biệt được hai ảnh có cùng các patch nhưng xếp khác chỗ không?

# %%
rng = np.random.default_rng(0)
T, D = 7, 16
Wq, Wk, Wv = (rng.normal(size=(D, D)) / np.sqrt(D) for _ in range(3))


def self_attention(X):
    Q, K, V = X @ Wq, X @ Wk, X @ Wv
    S = Q @ K.T / np.sqrt(D)
    P = np.exp(S - S.max(axis=1, keepdims=True))
    P /= P.sum(axis=1, keepdims=True)
    return P @ V


X = rng.normal(size=(T, D))
pos = rng.normal(size=(T, D))
perm = rng.permutation(T)
err_no_pos = np.abs(self_attention(X[perm]) - self_attention(X)[perm]).max()
err_pos = np.abs(self_attention(X[perm] + pos) - self_attention(X + pos)[perm]).max()
fig, ax = plt.subplots(figsize=(4.6, 3.3))
ax.bar(["không có pos", "có pos"], [max(err_no_pos, 1e-17), err_pos], color=["tab:gray", "tab:green"])
ax.set_yscale("log"); ax.set_ylabel("sai khác lớn nhất sau khi đảo")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Token `cls` đọc ảnh bằng cách nào?** Ở đầu, `cls` chỉ là một vector học được, không chứa thông tin gì về ảnh. Qua mỗi khối, nó dùng attention để **đọc** các patch. Hình dưới vẽ ma trận attention (kích thước $(N+1) \times (N+1)$, mỗi hàng cộng bằng 1) của một khối với trọng số ngẫu nhiên: hàng 0 là chỗ `cls` nhìn vào. Hàng 0 phân bố trên những token nào? Nếu bạn dùng `depth = 0` thì không có ma trận nào như thế, vậy logits phụ thuộc vào ảnh ra sao?

# %%
Xs = np.vstack([rng.normal(size=(1, D)), rng.normal(size=(6, D))]) + rng.normal(size=(7, D)) * 0.5
Q, K = Xs @ Wq, Xs @ Wk
S = Q @ K.T / np.sqrt(D)
A = np.exp(S - S.max(axis=1, keepdims=True))
A /= A.sum(axis=1, keepdims=True)
fig, ax = plt.subplots(figsize=(4.6, 3.8))
im = ax.imshow(A, cmap="viridis")
ax.set_xticks(range(7)); ax.set_xticklabels(["cls"] + [str(i) for i in range(6)], fontsize=8)
ax.set_yticks(range(7)); ax.set_yticklabels(["cls"] + [str(i) for i in range(6)], fontsize=8)
ax.set_xlabel("token được đọc (key)"); ax.set_ylabel("token đang đọc (query)")
ax.add_patch(plt.Rectangle((-0.5, -0.5), 7, 1, fill=False, ec="red", lw=2))
plt.colorbar(im, ax=ax, fraction=0.046)
plt.tight_layout()
plt.show()
