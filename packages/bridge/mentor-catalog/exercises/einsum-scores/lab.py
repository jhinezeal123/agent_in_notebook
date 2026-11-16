# %% [markdown]
# **Luật đọc einsum:** mỗi chữ là một trục. Chữ xuất hiện ở đầu vào nhưng **không** có ở đầu ra thì bị cộng dồn. Chữ có ở đầu ra thì giữ lại, theo đúng thứ tự viết.
#
# Ví dụ: `"ij,jk->ik"` là nhân ma trận; `"ii->"` là trace; `"ij->ji"` là chuyển vị.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
A = rng.normal(size=(2, 3))
Bm = rng.normal(size=(3, 4))
print("einsum('ij,jk->ik') == A @ B ?", np.allclose(np.einsum("ij,jk->ik", A, Bm), A @ Bm))
print("einsum('ij->ji') == A.T ?", np.allclose(np.einsum("ij->ji", A), A.T))
print("einsum('ij->') == A.sum() ?", np.isclose(np.einsum("ij->", A), A.sum()))

# %%
# Ma trận điểm của một head: hàng = query (t), cột = key (s).
T, S, d = 5, 8, 4
q = rng.normal(size=(T, d))
k = rng.normal(size=(S, d))
scores = q @ k.T
plt.figure(figsize=(5, 3))
plt.imshow(scores, cmap="coolwarm")
plt.xlabel("s (key)")
plt.ylabel("t (query)")
plt.title("scores[t, s] = q_t · k_s")
plt.colorbar()
plt.show()
