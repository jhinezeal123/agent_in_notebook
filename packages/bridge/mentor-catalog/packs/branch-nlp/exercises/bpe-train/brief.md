Viết `learn_merges(text, num_merges)`: học **bảng merge** của Byte-Pair Encoding (BPE) từ một văn bản nhỏ. Bảng merge là danh sách các cặp token được gộp lại, theo đúng thứ tự học; bài sau (`bpe-encode`) dùng nó để mã hoá văn bản mới.

BPE bắt đầu từ chuỗi **ký tự** của văn bản (mỗi ký tự Python là một token, kể cả dấu cách và xuống dòng; không tách từ), rồi lặp `num_merges` vòng. Mỗi vòng:

1. **Đếm** mọi cặp token liền kề `(chuỗi[i], chuỗi[i+1])` của chuỗi *hiện tại*. Mỗi vị trí `i` đóng góp một lần đếm, nên cặp chồng lấn đều được đếm: `"aaa"` có **hai** cặp `("a", "a")`.
2. **Chọn** cặp xuất hiện nhiều nhất. Nếu nhiều cặp bằng nhau, chọn cặp **nhỏ nhất theo so sánh tuple của Python** (so token trái trước, rồi token phải; so chuỗi theo thứ tự từ điển, nên `"a" < "aa" < "b"`). Luật hòa này làm kết quả hoàn toàn xác định.
3. **Thay** mọi chỗ của cặp đó trong chuỗi bằng **một token mới** là hai token nối lại (`("a", "b")` thành `"ab"`). Quét từ trái sang phải, không chồng lấn: `["a","a","a"]` với cặp `("a","a")` thành `["aa","a"]`.
4. Ghi cặp vừa chọn vào bảng.

Nếu chuỗi hiện tại không còn cặp liền kề nào (dài dưới 2 token) thì dừng sớm và trả về bảng đã có, ngắn hơn `num_merges`.

**Vào/ra**

- `text`: `str` (có thể rỗng). `num_merges`: `int ≥ 0`.
- Trả về `list` các tuple `(trái, phải)`, mỗi phần tử là `str`, đúng thứ tự học. `num_merges = 0` hoặc văn bản không có cặp nào thì trả về `[]`.

**Ví dụ.** `learn_merges("aaab", 2)` trả về `[("a", "a"), ("a", "b")]`: vòng 1 cặp `("a","a")` xuất hiện 2 lần, chuỗi thành `["aa","a","b"]`; vòng 2 hai cặp `("aa","a")` và `("a","b")` cùng 1 lần, luật hòa chọn `("a","b")`.

Ràng buộc: chỉ Python thuần (không cần thư viện nào); văn bản trong bài kiểm chỉ dài vài nghìn ký tự, không cần tối ưu thuật toán.
