# %% [markdown]
# **Ai dự đoán ai?** GPT chạy một chuỗi `T` token và cho ra `T` vector logits. Hình dưới vẽ một chuỗi `T = 6`: hàng là vị trí `t` của *đầu ra*, cột là vị trí `s` của *token thật*. Ô cam là một cặp (đầu ra ở `t`, token thật ở `s`) được tính vào loss. Nhìn hai thứ: ô cam nằm trên đường chéo nào, và hàng nào, cột nào không có ô cam. Trước khi code, tự đếm: loss được tính trên bao nhiêu cặp, và loss "không dịch" (ô cam nằm ngay trên đường chéo chính) sai ở đâu?

# %%
import numpy as np
import matplotlib.pyplot as plt

T = 6
right = np.zeros((T, T))
for t_ in range(T - 1):
    right[t_, t_ + 1] = 1
same = np.eye(T)
fig, ax = plt.subplots(1, 2, figsize=(9, 3.6))
for a, grid, title in [(ax[0], right, "đầu ra ở t đoán token ở t + 1"), (ax[1], same, "đầu ra ở t đoán token ở t (không dịch)")]:
    a.imshow(grid, cmap="Oranges", vmin=0, vmax=1.4)
    a.set_title(title, fontsize=10)
    a.set_xlabel("vị trí s của token thật")
    a.set_ylabel("vị trí t của đầu ra")
    a.set_xticks(range(T))
    a.set_yticks(range(T))
    a.text(0.5, -0.28, f"{int(grid.sum())} cặp trong loss", transform=a.transAxes, ha="center", fontsize=9)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Loss lúc khởi tạo.** Một mô hình chưa train với từ vựng `V = 65` nên có loss cỡ bao nhiêu? Hình dưới lấy logits ngẫu nhiên có độ lệch chuẩn `σ` rồi đo cross-entropy với nhãn ngẫu nhiên. Khi `σ` nhỏ, logits gần bằng nhau, phân phối gần đều. Đường đứt là `ln V`. Con số này là phép thử nhanh nhất trước khi train: loss lúc đầu lệch xa nó nghĩa là có chỗ sai.

# %%
rng = np.random.default_rng(0)
V = 65
sigmas = [0.02, 0.1, 0.5, 1.0, 2.0, 4.0]
losses = []
for s in sigmas:
    z = rng.normal(0, s, size=(4000, V))
    y = rng.integers(0, V, size=4000)
    z = z - z.max(axis=1, keepdims=True)
    logp = z - np.log(np.exp(z).sum(axis=1, keepdims=True))
    losses.append(-logp[np.arange(4000), y].mean())
fig, ax = plt.subplots(figsize=(5.5, 3.4))
ax.plot(sigmas, losses, "o-", color="#4c78a8", label="loss đo được")
ax.axhline(np.log(V), color="k", ls="--", label=f"ln {V} = {np.log(V):.2f}")
ax.set_xscale("log")
ax.set_xlabel("độ lệch chuẩn σ của logits")
ax.set_ylabel("cross-entropy trung bình")
ax.legend()
plt.tight_layout()
plt.show()

# %% [markdown]
# **Tham số nằm ở đâu?** Với `V = 65`, `block_size = 64`, `n_embd = C`, `n_layer = 4`: bảng embedding token và head mỗi cái `V·C`, bảng vị trí `block_size·C`, mỗi khối cỡ `12·C²` (attention `4C²`, MLP `8C²`) cộng một ít bias và LayerNorm. Hình dưới chia số tham số theo `C`. Để ý khi `C` lớn dần thì phần nào chiếm hết.

# %%
V, BS, L = 65, 64, 4
Cs = [16, 32, 64, 128, 256]
tok = [V * c for c in Cs]
pos = [BS * c for c in Cs]
head = [V * c for c in Cs]
blk = [L * (12 * c * c + 13 * c) for c in Cs]
fig, ax = plt.subplots(figsize=(6.5, 3.6))
bottom = np.zeros(len(Cs))
for name, vals, col in [("tok_emb", tok, "#4c78a8"), ("pos_emb", pos, "#f58518"), ("các khối", blk, "#54a24b"), ("head", head, "#b279a2")]:
    ax.bar([str(c) for c in Cs], vals, bottom=bottom, label=name, color=col)
    bottom += np.array(vals)
ax.set_xlabel("n_embd = C")
ax.set_ylabel("số tham số")
ax.legend()
plt.tight_layout()
plt.show()
