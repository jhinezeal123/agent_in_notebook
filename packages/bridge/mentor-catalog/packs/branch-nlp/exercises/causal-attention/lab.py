# %% [markdown]
# **Mask tam giác dưới.** Hàng là query (vị trí `t`), cột là key (vị trí `s`). Ô xanh là "được nhìn". Vị trí `t` nhìn các cột `0..t`: tam giác gồm *cả đường chéo*. Hình phải đếm số key mà mỗi query nhìn được: hàng 0 chỉ có đúng một (chính nó). Trước khi code, tự trả lời: nếu hàng 0 không có ô nào xanh thì chuyện gì xảy ra khi softmax chạy trên hàng đó?

# %%
import numpy as np
import matplotlib.pyplot as plt

T = 8
mask = np.tril(np.ones((T, T)))
fig, ax = plt.subplots(1, 2, figsize=(9, 3.4))
ax[0].imshow(mask, cmap="Greens", vmin=0, vmax=1)
ax[0].set_title("mask (xanh = được nhìn)")
ax[0].set_xlabel("key s")
ax[0].set_ylabel("query t")
ax[1].bar(range(T), mask.sum(axis=1), color="#4c78a8")
ax[1].set_title("số key mỗi query nhìn được")
ax[1].set_xlabel("query t")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Che trước hay sau softmax?** Hình dưới lấy một ma trận điểm ngẫu nhiên, làm softmax *rồi mới* nhân 0 vào các ô tương lai (cách làm sai). Tổng mỗi hàng không còn là 1: phần xác suất mà softmax đã chia cho các key tương lai bị vứt đi, và các trọng số còn lại vẫn mang dấu vết điểm của tương lai. Chỉ hàng cuối (nhìn được tất cả) còn tổng bằng 1.

# %%
rng = np.random.default_rng(0)
scores = rng.normal(size=(T, T)) * 2
e = np.exp(scores - scores.max(axis=1, keepdims=True))
soft_all = e / e.sum(axis=1, keepdims=True)
wrong = soft_all * mask
fig, ax = plt.subplots(1, 2, figsize=(9, 3.4))
im = ax[0].imshow(wrong, cmap="viridis")
ax[0].set_title("softmax rồi nhân mask (sai)")
ax[0].set_xlabel("key s")
ax[0].set_ylabel("query t")
fig.colorbar(im, ax=ax[0], fraction=0.046)
ax[1].bar(range(T), wrong.sum(axis=1), color="#e45756")
ax[1].axhline(1.0, color="k", ls="--", label="cần bằng 1")
ax[1].set_title("tổng mỗi hàng")
ax[1].set_xlabel("query t")
ax[1].legend()
plt.tight_layout()
plt.show()

# %% [markdown]
# **Shape trong một bước.** Với `B = 2`, `T = 5`, `C = 12`, `n_head = 3`: điểm attention là `(B, n_head, T, T)`, tức `(2, 3, 5, 5)`, còn mask `(T, T)` không có trục batch hay head. Ở hình dưới, mỗi ô của điểm là một cặp (query, key); mask `(5, 5)` được lặp lại cho cả 2 × 3 = 6 "tấm" điểm, nên *cùng một* mask áp cho mọi head và mọi mẫu trong batch.

# %%
B, nh, T5 = 2, 3, 5
m5 = np.tril(np.ones((T5, T5)))
fig, ax = plt.subplots(B, nh, figsize=(6, 4))
for b in range(B):
    for h in range(nh):
        ax[b, h].imshow(m5, cmap="Greens", vmin=0, vmax=1)
        ax[b, h].set_xticks([])
        ax[b, h].set_yticks([])
        ax[b, h].set_title(f"b={b}, head {h}", fontsize=8)
plt.suptitle("cùng một mask (T, T) cho mọi (b, head)", fontsize=10)
plt.tight_layout()
plt.show()
