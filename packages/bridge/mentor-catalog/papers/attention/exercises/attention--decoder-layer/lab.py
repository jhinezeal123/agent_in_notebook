# %% [markdown]
# **Ba chỗ attention, ba ma trận "ai được nhìn ai" khác nhau (§3.2.3).** Hàng là *query* (vị trí đang tính), cột là *key* (vị trí được nhìn); ô xanh là được nhìn.
#
# - Hình trái: self-attention của **encoder** trên câu nguồn dài 5 nhưng chỉ có 3 token thật, 2 token cuối là PAD. Không ai nhìn PAD.
# - Hình giữa: **masked self-attention** của decoder trên chuỗi đích dài 4: vị trí $t$ chỉ nhìn $t' \le t$ (tam giác dưới), để lúc sinh không nhìn trộm đáp án.
# - Hình phải: **cross-attention**: 4 query của decoder nhìn 5 key của encoder (độ dài khác nhau, ma trận không vuông). Không có chuyện nhìn "tương lai" ở đây vì câu nguồn được đọc xong hết; chỉ che PAD của câu nguồn.

# %%
import numpy as np
import matplotlib.pyplot as plt

S, T, real = 5, 4, 3
src_ok = np.arange(S) < real                           # (S,): token thật của câu nguồn
enc_self = np.tile(src_ok, (S, 1))                     # (S, S)
dec_self = np.tril(np.ones((T, T), dtype=bool))        # (T, T)
cross = np.tile(src_ok, (T, 1))                        # (T, S)

fig, ax = plt.subplots(1, 3, figsize=(11, 3.2))
panels = [
    (enc_self, "encoder self-attention", "key (câu nguồn)", "query (câu nguồn)"),
    (dec_self, "decoder masked self-attention", "key (chuỗi đích)", "query (chuỗi đích)"),
    (cross, "cross-attention", "key (câu nguồn)", "query (chuỗi đích)"),
]
for a, (m, title, xl, yl) in zip(ax, panels):
    a.imshow(m.astype(int), cmap="Greens", vmin=0, vmax=1)
    a.set_title(f"{title}\nshape {m.shape}", fontsize=9)
    a.set_xlabel(xl, fontsize=8)
    a.set_ylabel(yl, fontsize=8)
plt.tight_layout()
plt.show()
