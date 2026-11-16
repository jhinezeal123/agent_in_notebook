# %% [markdown]
# **Embedding = one-hot nhân ma trận.** Nếu $e_i$ là vector one-hot của token $i$ (dài $V$), thì $e_i^\top W$ chính là hàng $i$ của $W$. Tra bảng chỉ là cách làm phép nhân đó mà không tốn $O(V)$ cho mỗi token.
#
# Hình dưới: một câu 6 token, ma trận one-hot $(6, V)$, bảng $W$ $(V, d)$ và kết quả $(6, d)$.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
V, d = 10, 4
table = rng.normal(size=(V, d))
sentence = np.array([3, 7, 3, 1, 9, 3])
onehot = np.eye(V)[sentence]
vectors = onehot @ table

fig, ax = plt.subplots(1, 3, figsize=(11, 3.2), gridspec_kw={"width_ratios": [V, d, d]})
ax[0].imshow(onehot, cmap="Greys"); ax[0].set_title("one-hot (6, V)")
ax[0].set_yticks(range(6)); ax[0].set_yticklabels([f"id {i}" for i in sentence])
ax[1].imshow(table, cmap="coolwarm"); ax[1].set_title("bảng W (V, d)")
ax[2].imshow(vectors, cmap="coolwarm"); ax[2].set_title("one-hot @ W (6, d)")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Backward.** Vì out = onehot @ W nên $\partial L/\partial W = \text{onehot}^\top \cdot \partial L/\partial\,\text{out}$. Cột $i$ của one-hot có bao nhiêu số 1 thì hàng $i$ của gradient là tổng của bấy nhiêu hàng gradient upstream.
#
# Câu trên có token 3 xuất hiện **ba lần**. Nhìn hàng 3 của gradient dưới đây, rồi tự hỏi: cách viết nhanh (không dựng ma trận one-hot) của bạn có giữ được cả ba phần đóng góp không?

# %%
upstream = np.ones((6, d))  # giả sử mỗi vị trí nhận gradient toàn 1
grad_table = onehot.T @ upstream

fig, ax = plt.subplots(1, 2, figsize=(9, 3.2))
ax[0].imshow(grad_table, cmap="Blues"); ax[0].set_title("onehot.T @ upstream  (V, d)")
ax[0].set_ylabel("id"); ax[0].set_yticks(range(V))
ax[1].barh(range(V), np.bincount(sentence, minlength=V), color="tab:blue")
ax[1].invert_yaxis(); ax[1].set_title("số lần mỗi id xuất hiện")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Thực tế:** từ vựng $V$ cỡ 50 000, batch có vài nghìn token. Token phổ biến (dấu chấm, "the") xuất hiện hàng trăm lần mỗi batch; token hiếm thì không lần nào, nên hàng của nó nhận gradient 0. Tần suất dưới đây theo kiểu Zipf.

# %%
V_big = 2000
freq = 1.0 / np.arange(1, V_big + 1)
batch = rng.choice(V_big, size=4096, p=freq / freq.sum())
counts = np.bincount(batch, minlength=V_big)
plt.figure(figsize=(6, 3))
plt.loglog(np.arange(1, V_big + 1), np.sort(counts)[::-1] + 0.5, ".", ms=3)
plt.xlabel("hạng của token"); plt.ylabel("số lần trong batch (+0.5)")
plt.title(f"{(counts == 0).mean():.0%} hàng của W không nhận gradient ở batch này")
plt.tight_layout()
plt.show()
