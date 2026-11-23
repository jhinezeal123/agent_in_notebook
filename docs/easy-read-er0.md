# Easy-read — biên bản ER-0 (thử kỹ thuật)

Ngày 23/11/2026, nhánh `feat/easy-read`. Mục tiêu (`docs/easy-read.md` § F.1): trước khi viết ER-1, thử bốn điều mà thiết kế dựa vào. **Kết luận: cả bốn đều được; không có gì buộc phải đổi kiến trúc.** Có sáu chỗ thiết kế được chỉnh lại theo kết quả (cuối tài liệu).

| # | Điều cần thử | Kết quả | Cách thử (chạy lại được) |
|---|---|---|---|
| 1 | HTML của arXiv dùng được cho màn đọc | **Được.** 15/16 paper có HTML đầy đủ ngay trên `arxiv.org/html`, kể cả paper 2015–2017 | `node packages/bridge/test/debug/reader-arxiv-probe.mjs [id…]` |
| 2 | Chat có vai chạy được mà không có notebook | **Được.** Lượt, tool, job, card, đóng chat: không thao tác notebook nào | `packages/bridge/test/reader-er0.test.ts` (nằm trong `pnpm test`) |
| 3 | Widget trong `iframe srcdoc` có sandbox, chặn mạng, trong webview VS Code thật | **Được**, đủ 14 kiểm tra; không cần `frame-src` | `node packages/vscode/test/debug/reader-webview-probe/run.mjs <file.pdf>` |
| 4 | pdf.js trong webview VS Code | **Được** (`pdfjs-dist` 6.5.438): mở, rút chữ, dò id arXiv, vẽ trang thành PNG | cùng lệnh trên |

---

## 1. HTML của arXiv

Probe tải tuần tự, cách nhau 3 giây (điều khoản của arXiv), đếm những gì màn đọc cần. 10 paper ML 2023–2025 và 6 paper cũ hơn:

| arXiv | Paper | Nguồn | KB | Mục/mục con | Đoạn | Công thức đánh số | `<math>` | có TeX (`alttext`) | Hình | Bảng | Dấu lỗi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2312.00752 | Mamba | arxiv.org | 648 | 6/22 | 282 | 28 | 563 | 100 % | 32 | 7 | 0 |
| 2401.04088 | Mixtral | arxiv.org | 187 | 7/4 | 39 | 6 | 52 | 100 % | 11 | 4 | 0 |
| 2402.17764 | BitNet b1.58 | arxiv.org | 96 | 4/0 | 29 | 6 | 8 | 100 % | 5 | 4 | 0 |
| 2403.03206 | SD3 (rectified flow) | arxiv.org | 623 | 7/11 | 94 | 64 | 397 | 100 % | 24 | 7 | 0 |
| 2404.19756 | KAN | arxiv.org | 708 | 7/17 | 156 | 89 | 867 | 100 % | 25 | 6 | 0 |
| 2405.04434 | DeepSeek-V2 | arxiv.org | 704 | 5/12 | 87 | 62 | 230 | 100 % | 7 | 37 | 1 (`\reportnumber`) |
| 2405.21060 | Mamba-2 | arxiv.org | 1115 | 11/41 | 439 | 185 | 1200 | 100 % | 15 | 8 | 1 (`{listing*}`) |
| 2409.12191 | Qwen2-VL | arxiv.org | 662 | 5/10 | 77 | 8 | 72 | 100 % | 32 | 8 | 11 (`\acctonos`, `\accdialytika`) |
| 2410.05258 | Differential Transformer | arxiv.org | 380 | 5/10 | 59 | 42 | 224 | 100 % | 27 | 12 | 0 |
| 2501.12948 | DeepSeek-R1 | arxiv.org | 2008 | 7/30 | 211 | 26 | 129 | 100 % | 23 | 32 | 1 (`\reportnumber`) |
| 1706.03762 | Attention | arxiv.org | 184 | 8/12 | 70 | 12 | 142 | 100 % | 5 | 4 | 0 |
| 1512.03385 | ResNet | arxiv.org | 353 | 4/7 | 81 | 4 | 136 | 100 % | 7 | 11 | 0 |
| 2006.11239 | DDPM | arxiv.org | 987 | 8/8 | 56 | 42 | 376 | 100 % | 29 | 2 | 0 |
| 2010.11929 | ViT | arxiv.org | 289 | 6/19 | 74 | 11 | 167 | 100 % | 15 | 9 | 0 |
| 2106.09685 | LoRA | arxiv.org | 492 | 8/21 | 96 | 12 | 637 | 100 % | 8 | 18 | 0 |
| 1707.06347 | PPO | **không có** | — | — | — | — | — | — | — | — | — |

Phát hiện:

- **`arxiv.org/html` đã có cả paper cũ** (Attention 2017, ResNet 2015, LoRA 2021…): arXiv đã chuyển ngược. ar5iv chỉ còn là đường dự phòng.
- **TeX gốc có ở 100 % công thức** (`<math alttext="…">`), kể cả công thức trong câu. Agent đọc được đúng công thức của tác giả mà không cần ghép LaTeX.
- **Dấu lỗi của LaTeXML hiếm và nhỏ**: 10/15 paper không có dấu nào; số còn lại 1–11 dấu, đều là macro lạ không ảnh hưởng nội dung chính (`\reportnumber` ở trang đầu, dấu thanh tiếng Hy Lạp). Con số "~75 % chuyển không lỗi" là của toàn kho arXiv; với paper ML phổ biến thì tốt hơn nhiều.
- **Chuyển đổi hỏng vẫn trả 200**: `arxiv.org/html/1707.06347` là trang "Untitled Document" rỗng, ar5iv trả mỗi trang PDF thành một ảnh. Lý do: "mã nguồn" của PPO là một file `.tex` 220 byte chỉ `\includepdf` một PDF. Với paper như vậy cả HTML lẫn LaTeX đều vô dụng; chỉ còn PDF (và chữ rút bằng pdf.js). Probe nhận ra bằng điều kiện: có ít nhất một `ltx_section` hoặc ít nhất 10 `<math>`.
- **Hình**: đường dẫn tương đối dạng `2106.09685v2/x1.png`, giải theo URL trang (`https://arxiv.org/html/<id>`, không có dấu `/` cuối) thành `https://arxiv.org/html/2106.09685v2/x1.png`. Có vài thứ phải bỏ: logo arXiv (URL tuyệt đối tới `static.arxiv.org`), một biểu tượng nhỏ dạng `data:`.
- **Tham khảo**: `ltx_bibitem` có ở 14/15; DeepSeek-R1 không có mục nào (dùng cách in tham khảo khác) → danh sách tham khảo phải là tùy chọn.
- **Kích thước**: 96 KB – 2 MB một paper; lưu cục bộ không đáng kể.
- Các lớp LaTeXML hay gặp nhất (cho fixture của ER-1): `ltx_para`/`ltx_p`, `ltx_Math`, `ltx_equation`/`ltx_eqn_cell`/`ltx_tag`, `ltx_ref`/`ltx_cite`, `ltx_bibitem`/`ltx_bibblock`, `ltx_td`/`ltx_tr`/`ltx_th` (bảng), `ltx_listingline` (code), `ltx_figure`/`ltx_table`.

## 2. Chat không gắn notebook

`packages/bridge/test/reader-er0.test.ts` (5 test, đạt): một `Chat` với một vai giống gia sư (prompt riêng, một tool `paper_find`), host từ chối mọi thao tác notebook, id tab nằm ngoài cả hai dải của editor.

- Hai lượt chat: prompt của vai được gửi đi (lượt đầu có luật, lượt sau không), khối `<reader-selection>` đi kèm tin nhắn đến được agent; **không có thao tác notebook nào**.
- `chat.tools()` chỉ có tool của vai; `runTool` chạy không cần notebook.
- Card và `job` của `ChatPort` dùng được. Test ghi lại một điều thiết kế đã lường: `job` giữ tin nhắn của bạn tới khi job xong, nên người soạn của easy-read **không được** chạy như job của chat gia sư (E.4.2).
- Đóng chat gỡ vai, trạng thái `closed`.
- `isNotebookTool` nhận tên `paper_*` nhưng chưa nhận `reader_*` (khi agent báo tên trần); Claude Code báo tên dạng `mcp__notebook__…` nên đã khớp sẵn. ER-1 thêm `reader_\w+` vào biểu thức.

## 3. Widget trong webview VS Code

Chạy trong VS Code 1.147.0 đã cài (Electron 43.8.9, Chrome 150), như một lần "extension tests" với thư mục người dùng tạm, nên không đụng VS Code đang mở. CSP của trang thử là CSP dự định cho tab đọc:

```
default-src 'none'; img-src <cspSource> data: blob:; style-src <cspSource> 'unsafe-inline'; font-src <cspSource>;
script-src 'nonce-…' <cspSource>; connect-src <cspSource>; worker-src blob:
```

| Kiểm tra trong `<iframe sandbox="allow-scripts" srcdoc>` | Kết quả |
|---|---|
| script mang nonce của trang cha chạy | ✓ (không cần `frame-src`) |
| script không nonce · `onclick=` nội dòng | bị chặn · bị chặn |
| `<script type="module">` mang nonce | ✓ chạy |
| `eval` · `new Function` | bị chặn (`EvalError`) |
| origin | `null` (mờ) |
| `parent.document` · `localStorage` · `acquireVsCodeApi` | `SecurityError` · `SecurityError` · không có |
| `window.open` | `null` (popup bị chặn) |
| `fetch("https://arxiv.org/")` · `WebSocket` · ảnh từ mạng | bị chặn (CSP `connect-src`, `img-src`) |
| `<style>` nội dòng | áp dụng |
| frame chạy vòng lặp bận 1,5 s | trang đọc chỉ khựng **43 ms**: frame sandbox chạy ở tiến trình riêng |

| Worker | Kết quả |
|---|---|
| Worker từ `blob:` chạy phần tính | ✓ (7² = 49) |
| Worker lặp vô hạn | trang vẫn mượt (khựng 21 ms), `terminate()` dừng được |
| Worker thẳng từ URL tài nguyên của webview | **bị cấm** (khác origin: `vscode-resource.vscode-cdn.net` vs `vscode-webview://`) |

## 4. pdf.js trong webview

Cùng lần chạy, với PDF của LoRA (1,6 MB, 26 trang):

| Bước | Kết quả |
|---|---|
| nạp `pdf.min.mjs` (474 KB) bằng `import()` | 391 ms |
| worker: `fetch` URL tài nguyên → `Blob` → `new Worker(blob, { type: "module" })` | ✓ (worker 1,27 MB) — cách duy nhất, vì worker không nạp thẳng từ URL tài nguyên được |
| byte PDF từ extension host qua `postMessage` | tới nguyên vẹn dạng `Uint8Array` |
| `getDocument({ data, isEvalSupported: false })` | 174 ms |
| chữ của cả 26 trang | 90 000 ký tự, 1,8 s |
| dò dấu arXiv trong chữ | `arXiv:2106.09685v2` → PDF tải lên được nâng sang đường arXiv |
| công thức (Eq. 3) như pdf.js đưa ra | `h = W 0 x + ∆ W x = W 0 x + BAx (3)`: chỉ số dưới thành chữ rời; công thức đơn giản còn đọc được, công thức phức tạp thì không |
| vẽ trang 4 ở tỉ lệ 2 thành PNG | 1224 × 1584, 466 KB, 275 ms; công thức đọc rõ (`B ∈ ℝ^{d×r}`, `A ∈ ℝ^{r×k}`, `α/r`) |

---

## Thay đổi đưa vào thiết kế (`docs/easy-read.md`)

1. **E.2 nguồn**: `arxiv.org/html` là nguồn chính cho cả paper cũ; ar5iv chỉ dự phòng. Nhận ra chuyển đổi hỏng (không `ltx_section` và < 10 `<math>`) và nguồn LaTeX chỉ bọc PDF (`\includepdf`) → đi đường PDF. Dấu lỗi LaTeXML hiếm: **bỏ ý hiện từng mục hỏng bằng trang PDF**; giữ chỗ lỗi như LaTeXML in ra (có đánh dấu nhẹ), chỉ cả paper chuyển sang PDF khi chuyển đổi hỏng.
2. **E.2 hình**: giải đường dẫn theo URL trang, bỏ logo và biểu tượng của trang arXiv; tham khảo là tùy chọn.
3. **E.7.2 widget**: bỏ ghi chú "cần thử"; ghi rõ luật cho bộ kit và code widget: không `eval`/`new Function`, không thuộc tính sự kiện nội dòng (dùng `addEventListener`), script nào cũng mang nonce do màn đọc gắn khi ghép `srcdoc`.
4. **G.1 rủi ro widget**: frame sandbox chạy ở tiến trình riêng trên VS Code 1.147, vòng lặp nặng của phần vẽ không làm treo tab đọc. Vẫn giữ việc kiểm phần tính trong Worker có hẹn giờ (bắt lỗi toán, không chỉ chống treo).
5. **E.10 pdf.js**: `pdfjs-dist` 6.5.438 (đã thêm vào `packages/ui`); worker nạp qua fetch → blob, nên CSP cần `connect-src <cspSource>` và `worker-src blob:`. VSIX nặng thêm ~1,75 MB (`pdf.min.mjs` + worker).
6. **E.5 `paper_page`**: PNG tỉ lệ 2 nặng ~470 KB, trong khi kết quả tool gửi tối đa 4 ảnh / 3 MB. Dùng tỉ lệ 1,5 và JPEG chất lượng ~0,85 (ước ≤ 250 KB), chỉ gửi vùng trang chứa công thức khi biết vị trí.

## Việc của ER-1 mà ER-0 chỉ ra

- **Parse HTML ở bridge**: bridge chưa có bộ parse HTML. ER-1 cần một thư viện nhỏ (đề xuất `htmlparser2`, MIT) để dựng `ReaderDoc` từ HTML của LaTeXML và lấy `alttext`; phần làm sạch HTML để hiển thị dùng DOMPurify sẵn có của `ui` trong webview. Fixture cho test là một trang LaTeXML tự viết theo các lớp ở mục 1 (không chép HTML của paper vào repo).
- **`PanelCore`** phân loại tab chỉ bằng dấu của id (dương: notebook VS Code, âm: tab Chrome) và `chat.open` chỉ có hai đường. ER-1 thêm loại đích thứ ba (tab đọc, kèm `paperId`) thay vì chọn một dải số đặc biệt, và `server.ts: chat.open` nhận đích đó.
- **`fetch.ts`** hiện báo lỗi khi LaTeX ngắn hơn 2 000 ký tự (đúng với PPO); với easy-read, lỗi đó không chặn việc đọc: chữ cho agent lấy từ pdf.js.
- **`isNotebookTool`** thêm `reader_\w+`.

## File của ER-0

- `packages/bridge/test/debug/reader-arxiv-probe.mjs`: khảo sát HTML arXiv (không nằm trong bộ test; cần mạng).
- `packages/bridge/test/reader-er0.test.ts`: chat không gắn notebook (trong bộ test).
- `packages/vscode/test/debug/reader-webview-probe/` (`run.mjs`, `runner.cjs`, `page.mjs`, `ext.cjs`, `package.json`): thử widget sandbox và pdf.js trong VS Code thật; mở một cửa sổ VS Code riêng ~10 giây rồi tự đóng.
- `packages/ui/package.json`: thêm `pdfjs-dist` 6.5.438 (khóa phiên bản như các phụ thuộc khác của `ui`).
