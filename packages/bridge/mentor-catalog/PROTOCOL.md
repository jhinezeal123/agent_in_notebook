# Giao thức nội dung Mentor (phiên bản 1)

Tài liệu này quy định **cách thêm và định dạng mọi nội dung của Mentor**: chủ đề, sao, bài tập, test, câu hỏi, hint. Người hoặc AI nào thêm nội dung cũng làm theo đúng tài liệu này; máy đọc nội dung theo đúng tài liệu này (`packages/bridge/src/mentor/catalog.ts`), và lệnh `ainb mentor check` kiểm nội dung theo đúng tài liệu này.

Nếu bạn là AI được nhờ "thêm bài về X" hay "thêm chủ đề Y": đọc hết mục 1–3, làm theo mục 4–10, kết thúc bằng mục 11–12. Xem `exercises/layernorm/` làm mẫu về độ kỹ.

## 1. Ba điều không đổi

1. **Người học tự gõ mọi dòng code.** Không file nào người học thấy (đề, lab, starter, hint mức 0–2) được chứa lời giải.
2. **Máy chấm quyết định đúng sai**, bằng test ẩn chạy thật. Bài tốt là bài mà người hiểu sai một chỗ sẽ trượt đúng test nói về chỗ đó.
3. **Mọi bài tự chứng minh được mình đúng**: lời giải chuẩn qua hết test, starter trượt, mỗi bản cố tình sai trượt. Bài chưa qua kiểm tra thì chưa xong.

Người học: nghiên cứu sinh, nền competitive programming, giỏi lý thuyết, yếu ở chỗ biến công thức thành code, tensor/PyTorch, và trang giấy trắng. Mọi chữ người học thấy viết **tiếng Việt, giữ thuật ngữ tiếng Anh** (attention, logits, broadcasting, shape, gradient…).

## 2. Bạn đang thêm gì?

| Việc | Làm ở đâu | Mục |
|---|---|---|
| Thêm câu hỏi hoặc hint cho một bài đã có | Sửa thẳng `probes.json` / `hints.json` của bài đó (chỉ thêm) | 7, 8 |
| Thêm bài cho một sao đã có (ví dụ thêm bài PyTorch căn bản) | Một **gói**; bài ghi `"star": "<id sao cũ>"` | 3, 4 |
| Thêm một khái niệm mới vào chòm sao cũ (ví dụ BatchNorm vào Nền móng) | Một gói; khai sao mới với `"constellation": "<id chòm cũ>"` | 3 |
| Thêm một chủ đề hoàn toàn mới (ví dụ ML cổ điển) | Một gói có chòm sao riêng | 3 |
| Reproduce một paper | `papers/<id>/` | 13 |

Nội dung thêm sau **luôn nằm trong một gói** (`packs/<id>/`). Không sửa `map.json`, không thêm thư mục vào `exercises/` (đó là bộ gốc). Nhờ vậy: thêm một chủ đề là thêm một thư mục, bỏ một chủ đề là xóa một thư mục, và gói có lỗi thì chỉ phần lỗi của nó bị bỏ qua, Mentor vẫn chạy.

Các id đang có: sao và chòm sao trong `map.json`; bài trong `exercises/` và `packs/*/exercises/`. **Id là duy nhất trên toàn bộ catalog** (sao với sao, bài với bài, gói với gói).

### Thứ tự làm việc

1. Xác định việc theo bảng trên.
2. Xem cái đã có để không trùng và nối đúng chỗ: `map.json` (sao, chòm sao), `exercises/` và `packs/*/` (bài, gói). Đọc một bài mẫu gần chủ đề nhất.
3. Việc lớn hơn 2 bài thì **đề xuất dàn ý trước khi viết**: các sao (nối sau sao nào), mỗi sao những bài gì, độ khó và số phút. Yêu cầu chung chung ("thêm ML cơ bản") thì tự chọn phạm vi hợp lý cho một gói 3–8 sao và nói rõ đã chọn gì; chỉ hỏi lại khi có hai hướng khác hẳn nhau.
4. Viết từng bài một, `meta.json` sau cùng; bài nào xong thì kiểm ngay (mục 11) và sửa đến khi không còn dòng `✗`.
5. Cả gói xong: kiểm cả gói, rồi `reload` (mục 11).
6. Báo lại theo mục 12.

Người dùng không rành kỹ thuật: nói với họ bằng tiếng Việt, ngắn, dễ hiểu. Không commit, không push khi họ chưa bảo.

## 3. Gói chủ đề: `packs/<pack-id>/`

```
packs/classic-ml/
  pack.json
  exercises/
    linreg-closed-form/     ← một bài, định dạng ở mục 4
    kmeans-step/
```

`pack.json`:

```jsonc
{
  "protocol": 1,                        // phiên bản giao thức này
  "id": "classic-ml",                   // = tên thư mục; chữ thường, số, gạch ngang
  "name": "ML cổ điển",
  "description": "Các thuật toán trước deep learning, tự cài bằng NumPy.",

  // (tùy chọn) Chòm sao riêng của gói: hiện thành một bản đồ nhỏ ngay dưới bản đồ chính.
  "constellation": {
    "id": "classic-ml",
    "name": "ML cổ điển",
    "description": "Hồi quy, phân loại tuyến tính, phân cụm.",
    "daily": true                       // false: bài của chòm chỉ vào "Bài hôm nay" khi người học đặt nó làm trọng tâm
  },

  // (tùy chọn) Sao mới. Gói chỉ thêm bài cho sao cũ thì bỏ trống.
  "stars": [
    { "id": "linreg", "name": "Linear regression" },
    { "id": "logreg", "name": "Logistic regression", "after": ["linreg", "softmax"] },
    { "id": "kmeans", "name": "k-means", "after": ["broadcasting"] },
    { "id": "batchnorm", "name": "BatchNorm", "constellation": "foundation", "after": ["norm"] }
  ]
}
```

Quy tắc:

- **Sao** là một khái niệm (một ý học được trong 1–4 bài), không phải một bài. Tên ngắn, là thuật ngữ.
- `"constellation"` của sao: bỏ trống thì vào chòm riêng của gói. Ghi id một chòm cũ (`foundation`, `nlp`, `vision`, `generative`, `rl`, hoặc chòm của gói khác) thì sao gia nhập chòm đó.
- `"after"`: các sao nên học trước, ở bất kỳ chòm nào. Sao mở ra khi các sao trước đã bắt đầu học. Sao không có `after` mở ngay.
- **Không cần tọa độ.** Trong chòm riêng, sao tự xếp cột theo quan hệ `after`. Sao thêm vào bản đồ chính tự tìm chỗ trống gần các sao đứng trước. Chỉ ghi `"x"`, `"y"` (0–100) khi muốn tự đặt, và khi đó ghi cho mọi sao của chòm.
- `"daily"`: để `true` cho chủ đề nằm trên đường học chính. Để `false` cho chủ đề phụ (người học vẫn bấm vào sao để làm, hoặc đặt trọng tâm).
- Cỡ gói: 3–8 sao, mỗi sao 1–4 bài. Lớn hơn thì tách gói. Nối sao thành chuỗi, tránh quá 4 sao cùng một tầng.
- Gói có thể `"uses"`/`"variantOf"` bài của bộ gốc và của các gói xếp trước nó theo tên thư mục.

## 4. Một bài: `exercises/<id>/`

`<id>`: chữ thường, số, gạch ngang; nói được bài làm gì (`kmeans-step`, không phải `bai-3`). **Viết `meta.json` sau cùng**: thư mục chưa có `meta.json` chưa được nạp, nên bài viết dở không làm hỏng gì.

| File | Bắt buộc | Nội dung |
|---|---|---|
| `meta.json` | có | Mục 4.1 |
| `brief.md` | có | Đề (mục 4.3). Không bao giờ có lời giải. |
| `lab.py` | có (trừ biến thể) | Phòng công thức (mục 4.4) |
| `starter.py` | có | Chữ ký hàm, docstring có shape, thân `raise NotImplementedError`. Không import. |
| `given.py` | không | Code cho sẵn (dữ liệu, boilerplate). Hiện trong notebook, chạy trước code người học. |
| `reference.py` | có | Lời giải chuẩn. Chỉ định nghĩa (hàm, class, hằng); không in, không vẽ. |
| `tests.py` | có | Test ẩn (mục 5) |
| `mutants/<tên-lỗi>.py` | có, ≥ 3 | Lời giải cố tình sai (mục 6) |
| `probes.json` | có | Câu hỏi (mục 7) |
| `hints.json` | có | Hint (mục 8) |

### 4.1 `meta.json`

```jsonc
{
  "id": "kmeans-step",               // = tên thư mục
  "title": "Một bước k-means",
  "star": "kmeans",                  // id một sao (cũ, hoặc khai trong pack.json)
  "skills": ["tensor", "formula"],   // 1–3 kỹ năng, mục 9
  "difficulty": 1250,                // 800–2400, mục 9
  "minutes": 20,                     // 5–60: thời gian phần Dựng
  "requires": ["numpy"],             // module mà test import. Bài PyTorch: ["numpy", "torch"]
  "order": 1,                        // thứ tự trên cùng sao
  "functions": ["assign", "update"], // tên người học phải định nghĩa (hàm hoặc class)
  "prelude": "import numpy as np",   // chạy trước code người học, test và lời giải
  "probes": 2,                       // số câu bảo vệ phải trả lời để xong bài (1–5)

  // Tùy chọn
  "uses": ["id-bai-truoc"],          // code đạt của người học ở bài đó chạy trước bài này
  "variantOf": "id-bai-goc",         // biến thể: đổi một chi tiết của bài gốc
  "predict": "Câu người học dự đoán trước khi code",   // bắt buộc với biến thể
  "judgeSeconds": 60                 // thời gian tối đa một lần chấm (10–900)
}
```

`prelude` cho bài PyTorch: `"import numpy as np\nimport torch\nimport torch.nn as nn\nimport torch.nn.functional as F"`.

Bài trong gói không dùng `"diagnostic"` (bộ chẩn đoán là của bộ gốc) và không dùng `"paper"`.

### 4.2 Các dạng bài

Mọi dạng dùng chung một định dạng; khác nhau ở cách soạn.

| Dạng | Người học làm gì | Cách soạn |
|---|---|---|
| **Cài công thức** | Viết hàm từ công thức | Dạng mặc định. Đề có công thức và shape; test so với `ref` trên dữ liệu ngẫu nhiên. |
| **Phản xạ tensor** | Viết phép biến đổi shape/index không dùng vòng lặp | Hàm nhỏ, 5–10 dòng. Test có ca shape lạ (batch 1, chiều thừa) và test cấm vòng lặp nếu đó là mục đích. |
| **Đoán shape** | Trả về shape của từng dòng trước khi chạy | `functions` là hàm trả tuple/list shape (`def shapes(): return [(2, 3), ...]`); đề in đoạn code cần đoán; test so từng phần tử, thông báo nói dòng nào sai. |
| **Backward bằng tay** | Viết gradient | Test dùng `t.grad_close` hoặc sai phân hữu hạn. |
| **Tìm lỗi** | Sửa code có lỗi cài sẵn | `starter.py` là code chạy được nhưng sai (1–2 lỗi thật); đề tả triệu chứng, không chỉ chỗ; `reference.py` là bản đã sửa. Xem `exercises/mlp-train-debug/`. |
| **Biến thể** | Đổi một chi tiết của bài đã làm, dự đoán trước | `variantOf` + `predict`; không cần `lab.py`; cùng sao với bài gốc. Xem `exercises/rmsnorm/`. |
| **Dựng dần** | Bài sau dùng code bài trước | `uses`; lời giải chuẩn của bài trước chạy trước lời giải chuẩn bài này. |

Dạng chưa có trong bảng (ví dụ bài chỉ gồm câu hỏi, không code) **chưa được máy hỗ trợ**: đừng tự chế định dạng; đưa câu hỏi vào `probes.json` của một bài code liên quan.

### 4.3 Đề: `brief.md`

Ngắn, đủ để code mà không phải đoán:

1. Một câu: viết gì (tên hàm kèm tham số).
2. Công thức, LaTeX (`$...$`, `$$...$$`).
3. **Shape vào/ra** của từng tham số.
4. Ràng buộc và ca biên cần lo (ổn định số, không sửa đầu vào, phải khớp hàm nào của PyTorch).

Không có code lời giải, không có pseudo-code từng bước (đó là hint mức 2).

### 4.4 Phòng công thức: `lab.py`

File dạng percent: `# %%` mở cell code, `# %% [markdown]` mở cell markdown (mỗi dòng bắt đầu `# `). Mục đích là **trực giác trước khi code**: một ví dụ số nhỏ chạy được và **ít nhất một hình matplotlib** (đồ thị, heatmap, sơ đồ trục nào bị tác động). Không lộ code lời giải: vẽ hiện tượng, không cài hàm của bài. Chạy < 10 giây trên CPU, tự import thứ nó cần.

## 5. Test: `tests.py`

Ít nhất **4** hàm `def test_<tên>(user, ref):`, mỗi hàm có **docstring một dòng tiếng Việt**: đó là tên test người học thấy trên thẻ kết quả.

`user` và `ref` là namespace (dict) của người học và của lời giải chuẩn. Lấy hàm bằng `need(user, "ten_ham")`. So với `ref` trên dữ liệu ngẫu nhiên có seed.

Có sẵn đối tượng `t`:

| Hàm | Dùng khi |
|---|---|
| `t.seed(n)` | đặt seed cho random, numpy, torch |
| `t.close(got, want, tol=1e-5, what="...")` | so giá trị (numpy hoặc tensor); báo shape sai hoặc độ lệch lớn nhất |
| `t.shape(x, (..), what="...")` | kiểm shape |
| `t.grad_close(f_user, f_ref, *inputs, tol=1e-4)` | gradient theo các đầu vào float giống nhau |
| `t.load_into(module, ref_module)` | chép trọng số module chuẩn sang module người học (cùng tên tham số) |
| `t.report(name, value)` | (thí nghiệm) con số đo được |

Quy tắc:

- **Một test bắt một ý**: shape; giá trị trên dữ liệu thường; từng ca biên (hàng hằng số, logits rất lớn, mask toàn 0, batch 1); gradient khi bài là về backward; không sửa đầu vào tại chỗ khi điều đó quan trọng.
- **Mỗi hiểu nhầm đáng kể có một test riêng**, và có một mutant tương ứng (mục 6).
- Lời nhắn assert bằng tiếng Việt, gợi chỗ sai mà **không lộ đáp án**. Được: "Sai khi phương sai rất nhỏ: ε nằm ở đâu?". Không được: dán công thức đúng.
- Tất định (có seed), nhanh (cả file < 5 giây), không cần mạng, không cần GPU.
- Không import ở đầu file ngoài thứ đã có trong `prelude`; cần thêm thì import trong hàm test.

## 6. Bản cố tình sai: `mutants/<tên-lỗi>.py`

Ít nhất **3** file. Mỗi file là một lời giải đầy đủ có **đúng một lỗi mà người thật hay mắc**: sai trục, quên một hạng, lệch một vị trí, quên `keepdims`, quên `detach`, ε đặt sai chỗ, chia cho N thay vì N−1. Tên file là tên lỗi (`eps-outside.py`, `batch-axis.py`).

Mỗi bản **phải chạy được** (không lỗi cú pháp, không lỗi import) và **phải trượt ít nhất một test**. Bản sai mà qua hết test nghĩa là test còn lỏng: thêm test, đừng bỏ mutant.

## 7. Câu hỏi: `probes.json`

Ngân hàng câu hỏi mentor dùng ở Phòng công thức (câu bẫy trước khi code) và ở phần Bảo vệ (sau khi qua test). Ít nhất `probes` + 1 câu; nên 4–6.

```jsonc
[
  {
    "q": "Vì sao ε nằm trong căn? Nếu viết (x − μ)/(σ + ε) thì gradient khi σ² → 0 ra sao?",
    "tag": "eps-placement",          // hiểu nhầm mà câu trả lời sai để lộ; kebab-case
    "answer": "Đạo hàm của sqrt(σ²) là 1/(2σ), tiến tới vô cùng khi σ² → 0; ε trong căn giữ mọi thứ hữu hạn.",
    "kind": "why",                   // tùy chọn, bảng dưới
    "stage": "defend"                // tùy chọn: "lab" (hỏi trước khi code) | "defend" (hỏi sau khi đạt). Bỏ trống: lúc nào cũng được
  }
]
```

| `kind` | Câu hỏi về |
|---|---|
| `why` | vì sao dòng/hạng này cần |
| `break` | bỏ hoặc đổi nó thì hỏng gì, hỏng ở đâu |
| `shape` | shape tại một điểm, hoặc sau một thay đổi |
| `edge` | ca biên: đầu vào đặc biệt cho ra gì |
| `compare` | khác gì một thứ gần giống (LayerNorm với BatchNorm) |
| `trap` | câu dễ trả lời sai theo trực giác |

Quy tắc:

- Câu hỏi **không trả lời được bằng cách đọc lại code**: hỏi vì sao, hỏi điều gì xảy ra nếu, hỏi con số cụ thể.
- `answer` ghi điều một câu trả lời đúng **phải nói**, đủ để chấm 0/1/2. Người học không bao giờ thấy nó nguyên văn.
- `tag` là tên hiểu nhầm, đi vào Sổ lỗi sai và được hỏi lại sau vài ngày. Hai câu cùng một hiểu nhầm thì dùng chung tag. **Không đổi tag đã có**: lịch ôn của người học bám vào nó.
- Có ít nhất một câu `stage: "lab"` (bẫy trước khi code) và hai câu cho phần bảo vệ.

## 8. Hint: `hints.json`

Thang gợi ý có 5 mức; người học bấm "Xin gợi ý" để lên từng mức, mỗi mức trừ điểm bài. Tác giả soạn sẵn mức 0–3; mentor **chọn hint hợp với chỗ người học đang kẹt và diễn đạt lại** theo code của họ. Mức 4 là lời giải chuẩn, máy tự lấy từ `reference.py`.

| Mức | Là gì | Được chứa |
|---|---|---|
| 0 | Câu hỏi ngược | Chỉ câu hỏi. Không tên hàm họ chưa dùng, không code. |
| 1 | Hướng đi | Lời: tính gì tiếp, bằng loại phép toán nào. Không code, không pseudo-code. |
| 2 | Pseudo-code | Các bước, hoặc shape từng bước. Không phải Python chạy được. |
| 3 | Đoạn code nhỏ | Tối đa **8 dòng** code thật, cho đúng chỗ khó nhất, không phải cả bài. |

```jsonc
[
  { "level": 0, "test": "test_eps_inside_sqrt", "text": "Khi phương sai gần 0, mẫu số của bạn bằng bao nhiêu?" },
  { "level": 1, "text": "Tính trung bình và phương sai theo trục cuối, giữ chiều để broadcast được với x." },
  { "level": 2, "when": "chưa biết thứ tự các bước", "text": "mu = mean theo trục cuối (giữ chiều)\nvar = phương sai theo trục cuối (giữ chiều)\ny = (x - mu) / căn(var + eps), rồi nhân gamma, cộng beta" },
  { "level": 3, "when": "kẹt ở keepdims", "text": "```python\nmu = x.mean(axis=-1, keepdims=True)\n```" }
]
```

- `"when"` (tùy chọn): người học đang kẹt ở đâu. Một mức có thể có nhiều hint cho nhiều chỗ kẹt khác nhau.
- `"test"` (tùy chọn): tên một hàm trong `tests.py`. Hint mức 0 có `test` được đưa cho mentor **ngay khi test đó là test trượt đầu tiên của một lần chấm** (không cần người học xin): đây là cách dẫn dắt tốt nhất, nên có cho mỗi test về ca biên. Mọi hint mức 0 khác mentor luôn có sẵn để hỏi.
- Bắt buộc: ít nhất một hint cho mỗi mức 1, 2, 3; nên có 2–4 câu mức 0.
- Hint mức 0–2 không được chứa nguyên một dòng nào của `reference.py`. Code trong hint đặt trong khối ```` ```python ````.
- Hint tăng dần: người đọc mức 1 chưa làm được thì mức 2 phải cho họ thêm thứ mới, không nhắc lại.

## 9. Độ khó, kỹ năng, thời lượng

`difficulty` là "rating của bài" (người học thắng bài khó hơn rating của mình thì tăng mạnh). Đặt theo các mốc đã có, đừng đặt theo cảm giác:

| Mốc | Bài |
|---|---|
| 1000 | `broadcast-pairwise`: một phép broadcasting |
| 1150–1300 | `gather-mask-nll`, `dropout`, `stable-softmax-ce`: một công thức, 1–2 ca biên |
| 1350–1450 | `layernorm`, `adam-step`, `rnn-cell`: công thức có trạng thái hoặc trục dễ nhầm |
| 1550–1700 | `scaled-dot-attention`, `conv2d`, `multi-head-attention`: nhiều bước, shape 3–4 chiều |
| 1850 | `transformer-block`: ghép nhiều thành phần |
| 2000+ | thành phần của paper, thí nghiệm |

Người mới bắt đầu ở 1000. Biến thể đặt cao hơn bài gốc 100–150.

`skills` (1–3, kỹ năng chính đặt trước):

| Id | Kỹ năng | Chọn khi cái khó của bài là |
|---|---|---|
| `tensor` | Tensor & PyTorch | shape, broadcasting, indexing, API |
| `formula` | Công thức → code | đọc công thức, ký hiệu, ổn định số |
| `blank` | Dựng từ trang trắng | tự chia hàm, tự quyết cấu trúc |
| `train` | Train & debug | vòng lặp train, tìm lỗi, đọc loss |
| `theory` | Lý thuyết sâu | hiểu vì sao, hệ quả của một lựa chọn |

`minutes`: thời gian phần Dựng cho người vừa đủ trình. Một buổi học là 20–40 phút, nên bài quá 30 phút hãy tách làm hai (dùng `uses`).

## 10. Bài PyTorch

- Ưu tiên **hàm thuần nhận tensor**. Bài `nn.Module`: đề và starter cố định **tên thuộc tính** (`self.qkv = nn.Linear(...)`), để test chép trọng số bằng `t.load_into`.
- Test chạy CPU, `float32`, `tol=1e-5` (1e-4 cho phép tính dồn), batch nhỏ.
- Nếu bài là tự viết một hàm có sẵn của PyTorch, có test bắt lời giải gọi thẳng hàm đó.
- `"requires"` **phải** có `"torch"`. Máy dev không có PyTorch, nên bài như vậy chỉ đến tay người học sau khi được kiểm trên Kaggle (mục 11). Vì không chạy thử được tại máy, đọc lại từng test và từng mutant, tự hỏi mutant này có thật sự trượt không.

## 11. Kiểm tra và đưa vào dùng

Chạy từ thư mục gốc của repo. (Lệnh `ainb` là `node packages/bridge/dist/cli.js`; nếu nó chưa biết `mentor check`, chạy `pnpm --filter @ainb/bridge build` một lần. Thêm nội dung thì không cần build lại.)

```
pnpm ainb mentor check <pack-id>        # hoặc <id bài>; không ghi gì: mọi gói; --all: cả bộ gốc
```

Với mỗi bài, lệnh này kiểm: đúng giao thức (các quy tắc đếm được ở mục 4–8), cú pháp Python của mọi file, rồi **chạy thật** bằng Python của máy: lời giải chuẩn qua mọi test hai lần, starter trượt, mọi mutant chạy được và trượt, lab chạy được, lời giải không lọt vào notebook, chấm đủ nhanh. Nó cũng liệt kê những gì trong gói bị bỏ qua và lý do (file sai, id trùng, sao không tồn tại) và các thư mục bài chưa có `meta.json`.

- Dòng `✗`: phải sửa. Dòng `nên sửa`: bài vẫn dùng được nhưng yếu.
- Dòng `…` "máy này thiếu torch": bài cần Kaggle. Người dùng mở một notebook Kaggle trong Chrome (VS Code đang mở, máy Kaggle bật), rồi:

```
pnpm ainb mentor verify <id…>           # ghi kết quả vào verified.json
```

  Sửa `tests.py`, `reference.py`, `starter.py`, `given.py`, `lab.py`, `brief.md`, `meta.json` hay mutant của bài PyTorch thì phải verify lại. Sửa `probes.json`, `hints.json` thì không.

Khi mọi thứ đạt:

```
pnpm ainb mentor reload                 # Mentor đang chạy đọc lại catalog; trang chủ tự cập nhật
```

## 12. Xong việc

Trước khi báo xong:

- [ ] `pnpm ainb mentor check <pack-id>` không còn dòng `✗`.
- [ ] Mỗi bài: ≥ 4 test có docstring, ≥ 3 mutant, ≥ `probes` + 1 câu hỏi, hint đủ mức 1–3.
- [ ] Đọc lại `brief.md`, `lab.py`, `starter.py`, hint mức 0–2 như người học: không thấy lời giải ở đâu.
- [ ] Độ khó đặt theo bảng mốc; sao mới có `after` hợp lý.
- [ ] Đã `reload`, hoặc nói rõ bài nào còn chờ kiểm trên Kaggle.

Báo lại cho người dùng bằng tiếng Việt, ngắn: thêm những sao và bài nào (tên, độ khó, số phút), nằm ở đâu trên trang Mentor, bài nào chưa hiện vì chờ Kaggle và họ cần làm gì.

**Giữ ổn định với lịch sử học:**

- Không đổi `id` của bài, sao, gói đã có người học; không đổi `tag` câu hỏi. Muốn thay một bài: thêm bài mới, để bài cũ.
- Xóa một gói là an toàn với máy (lịch sử cũ vẫn đọc được), nhưng các bài của nó biến khỏi bản đồ và lịch ôn.
- Sửa nội dung một bài đã có (đề rõ hơn, thêm test) thì được; thêm test có thể làm bài cũ của người học không còn đạt khi ôn, nên chỉ thêm test khi test cũ để lọt lỗi thật.

## 13. Paper mốc: `papers/<paperId>/`

Một paper mốc khép một chòm sao. Thư mục gồm:

- `paper.json`: `{"id", "title", "authors", "year", "url", "arxiv", "closes": "<id chòm trong map.json>", "goal": "1–2 câu", "status": "ready"}`
- `given.py`: code cho sẵn chung của paper (dữ liệu, phần không thuộc ý tưởng paper). Chạy trước mọi bài của paper; chỉ định nghĩa, tải dữ liệu nằm trong hàm.
- `exercises/<paperId>--<slug>/`: các thành phần, đúng định dạng bài ở mục 4–8, thêm trong `meta.json`:
  - `"cites": "Eq. 1, §3.2"` (chỗ trong paper), `"role": "formula" | "component" | "experiment"`, `"uses": ["<id bài trước của paper>"]`.
  - `"star"`: điền id của chính bài (catalog tự gán lại).
- Thành phần cuối là **thí nghiệm** (`"role": "experiment"`, `"judge": "kernel"`, `"judgeSeconds": 120`, `"predict"`, `"metrics": [{"name", "paper": "con số trong paper", "unit"}]`): người học viết vòng lặp train dùng code của các bài trước, train bản thu nhỏ ≤ 15 phút trên Kaggle, để mô hình trong biến toàn cục (ví dụ `model`). `reference.py` là vòng train chuẩn; test **không train**, chỉ đo `user["model"]` trên dữ liệu tự tạo, gọi `t.report`, rồi assert ngưỡng đạt. Cần ít nhất 1 test và 1 mutant (mô hình chưa train phải trượt).

Paper người học tự đưa vào đi theo luồng "xưởng" trong ứng dụng, không soạn tay ở đây.

## 14. Phiên bản

Đây là giao thức **1** (`CONTENT_PROTOCOL` trong `catalog.ts`). Gói ghi `"protocol"` lớn hơn số máy đọc được thì bị bỏ qua kèm thông báo. Thay đổi làm gói cũ không còn hợp lệ thì tăng số; thêm trường tùy chọn thì không.
