# %% [markdown]
# **Thứ tự áp merge quyết định kết quả.** Cùng văn bản `"abc"` và cùng hai merge `(a,b)` và `(b,c)`: chữ `b` chỉ thuộc về được một token. Hình dưới (viết tay, không phải kết quả của hàm bạn sẽ viết) cho thấy hai thứ tự cho hai cách cắt khác nhau. Bảng merge là một *danh sách có thứ tự*, không phải một tập.

# %%
import matplotlib.pyplot as plt


def draw(ax, row, label, toks):
    x = 0.0
    for tok in toks:
        w = 0.5 * len(tok) + 0.4
        ax.add_patch(plt.Rectangle((x, -row), w, 0.8, fc="#f2cf5b" if len(tok) > 1 else "#d9e4f1", ec="k"))
        ax.text(x + w / 2, -row + 0.4, tok, ha="center", va="center")
        x += w + 0.08
    ax.text(-0.2, -row + 0.4, label, ha="right", va="center", fontsize=9)


fig, ax = plt.subplots(figsize=(8, 2.4))
draw(ax, 0, "ký tự", ["a", "b", "c"])
draw(ax, 1, "merge (a,b) rồi (b,c)", ["ab", "c"])
draw(ax, 2, "merge (b,c) rồi (a,b)", ["a", "bc"])
ax.set_xlim(-6, 5)
ax.set_ylim(-2.3, 1.2)
ax.axis("off")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Chồng lấn khi thay.** Hàng `"aaaaa"` bên dưới: mỗi hộp là một token sau lần lượt từng merge của bảng `[(a,a), (aa,a)]`. Mỗi merge quét một lượt trái sang phải; token đã gộp không được dùng lại. Hãy thử tự dự đoán hàng thứ ba trước khi nhìn (nó cũng được vẽ tay).

# %%
fig, ax = plt.subplots(figsize=(8, 2.4))
draw(ax, 0, "ký tự", ["a", "a", "a", "a", "a"])
draw(ax, 1, "sau (a,a)", ["aa", "aa", "a"])
draw(ax, 2, "sau (aa,a)", ["aa", "aaa"])
ax.set_xlim(-6, 6)
ax.set_ylim(-2.3, 1.2)
ax.axis("off")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Số token giảm dần.** Dãy số dưới là số token của `"aaabdaaabac"` sau 0, 1, 2 và 3 merge của bảng `[(a,a), (a,b), (aa,ab)]` (viết tay). Mã hoá một văn bản dài hơn nhiều bằng bảng học trên chính nó là cách để thấy "nén": cùng văn bản, ít token hơn.

# %%
sizes = [11, 9, 7, 5]
plt.figure(figsize=(4.5, 2.6))
plt.plot(range(len(sizes)), sizes, "o-")
plt.xlabel("số merge đã áp")
plt.ylabel("số token")
plt.xticks(range(len(sizes)))
plt.tight_layout()
plt.show()
