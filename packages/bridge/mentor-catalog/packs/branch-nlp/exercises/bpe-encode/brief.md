Viết hai hàm `encode(text, merges)` và `decode(tokens)`: dùng **bảng merge** để cắt một văn bản bất kỳ thành các token BPE, và ghép token lại thành văn bản.

Bài `bpe-train` của bạn đã định nghĩa `learn_merges(text, num_merges)`, trả về bảng merge: một `list` các tuple `(trái, phải)` theo thứ tự học. Bạn dùng lại nó để thử ở notebook (máy chấm của bài này tự lấy bảng từ lời giải chuẩn, nên chỉ cần hai hàm mới).

**`encode(text, merges)`**

- Bắt đầu từ danh sách ký tự của `text` (mỗi ký tự là một token `str`).
- Áp các merge **theo đúng thứ tự trong `merges`** (thứ tự đã học): với mỗi cặp `(trái, phải)`, thay mọi chỗ có hai token liền kề bằng đúng `trái` và `phải` bằng **một** token là hai chuỗi nối lại. Quét từ trái sang phải, không chồng lấn: `["a","a","a"]` với `("a","a")` thành `["aa","a"]`.
- Mỗi merge chỉ được áp một lượt qua cả chuỗi (cho tới hết chuỗi), rồi sang merge kế tiếp. Merge được so khớp theo **cặp token**, không phải theo chữ.
- Ký tự không xuất hiện trong bảng merge nào vẫn là một token riêng (không bị bỏ).
- Trả về `list` các `str`. Không sửa `merges`; gọi hai lần với cùng đầu vào phải ra cùng kết quả.

**`decode(tokens)`**: nhận `list` token `str` và trả về văn bản `str` mà chúng biểu diễn.

**Ràng buộc và ca biên**

- Với mọi `text` và mọi `merges` (kể cả rỗng): `decode(encode(text, merges)) == text`.
- `encode("", merges)` là `[]`; `decode([])` là `""`.
- Ví dụ: với `merges = [("a", "b"), ("ab", "c")]`, `encode("abcab", merges)` là `["abc", "ab"]`.
- Python thuần.
