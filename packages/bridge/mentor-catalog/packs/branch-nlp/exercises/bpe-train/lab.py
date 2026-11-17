# %% [markdown]
# **Đếm cặp liền kề: thứ BPE nhìn vào mỗi vòng.** Văn bản bên dưới có ít chữ cái khác nhau, nên nhiều cặp lặp lại. Hình dưới là số lần của từng cặp ký tự liền kề *trước khi merge gì cả* (mỗi vị trí `i` đóng góp một lần, kể cả khi hai cặp chồng lấn nhau). Cột cao nhất là cặp vòng đầu tiên sẽ gộp; hai cột cao bằng nhau là lúc cần luật hòa.

# %%
from collections import Counter
import matplotlib.pyplot as plt

text = "low low low lower lower newest newest widest"
pairs = Counter(zip(text, text[1:]))
top = pairs.most_common(12)
labels = ["".join(p).replace(" ", "_") for p, _ in top]
fig, ax = plt.subplots(figsize=(8, 3))
ax.bar(labels, [c for _, c in top], color="#4c78a8")
ax.set_ylabel("số lần xuất hiện")
ax.set_title("12 cặp ký tự liền kề phổ biến nhất (_ là dấu cách)")
plt.tight_layout()
plt.show()
print("Số cặp khác nhau:", len(pairs), "| tổng số vị trí:", len(text) - 1)

# %% [markdown]
# **Chuỗi co lại sau mỗi merge, và token mới tạo cặp mới.** Dưới đây là ví dụ viết tay trên `"aaabdaaabac"` (không phải kết quả của hàm bạn sẽ viết): ba chuỗi liên tiếp sau mỗi lần thay một cặp bằng một token nối. Mỗi hộp là một token. Quan sát: sau lần thay đầu, `("aa", "a")` và `("a", "b")` là những cặp *chưa từng tồn tại* trong chuỗi ký tự ban đầu.

# %%
steps = [
    ("ban đầu", ["a", "a", "a", "b", "d", "a", "a", "a", "b", "a", "c"]),
    ("thay (a,a) bằng aa", ["aa", "a", "b", "d", "aa", "a", "b", "a", "c"]),
    ("thay (a,b) bằng ab", ["aa", "ab", "d", "aa", "ab", "a", "c"]),
]
fig, ax = plt.subplots(figsize=(9, 2.6))
for row, (name, toks) in enumerate(steps):
    x = 0.0
    for tok in toks:
        w = 0.55 * len(tok) + 0.35
        ax.add_patch(plt.Rectangle((x, -row), w, 0.8, fc="#f2cf5b" if len(tok) > 1 else "#d9e4f1", ec="k"))
        ax.text(x + w / 2, -row + 0.4, tok, ha="center", va="center")
        x += w + 0.08
    ax.text(-0.2, -row + 0.4, f"{name}  ({len(toks)} token)", ha="right", va="center", fontsize=9)
ax.set_xlim(-6.5, 11)
ax.set_ylim(-2.3, 1.2)
ax.axis("off")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Chồng lấn.** Trong `"aaa"` có hai cặp `("a","a")` nhưng chúng dùng chung chữ `a` ở giữa. Đếm thì tính cả hai; khi thay chỉ được một. Trước khi code, tự trả lời: `"aaaaa"` sau một lần thay `("a","a")` quét từ trái sang phải là chuỗi gì?
