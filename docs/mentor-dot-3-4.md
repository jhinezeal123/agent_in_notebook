# Mentor — spec thiết kế đợt 3 (Reproduce paper) và đợt 4 (Bốn nhánh)

Trạng thái: **đã duyệt; nội dung đã soạn xong và đã kiểm đủ trên Kaggle** (17/11/2026). Năm quyết định ở G.3 theo đề xuất. Phần máy của đợt 3 (3a, 3b, 3c) đã cài. Nội dung: 4 bài PyTorch căn bản, 35 bài đợt 4 (bốn gói `packs/branch-*`), bảy paper mốc (`papers/attention`, `lora`, `ddpm`, `resnet`, `vit`, `dqn`, `ppo`). Bài chỉ cần numpy qua `ainb mentor check` trên máy; **mọi bài cần PyTorch đã qua `ainb mentor verify` trên Kaggle (2 × T4)** và có dấu trong `verified.json`, nên đã tới tay người học (`ainb mentor reload`: 79 bài). Lỗi gặp và đã sửa trong lúc kiểm: `docs/mentor-verify-kernel-busy.md`.

Tài liệu này nối tiếp "Spec: Mentor" (đã duyệt cho cả bốn đợt ở mức trải nghiệm, mục 3.11 và mục 5) và `docs/architecture.md` § Mentor (cách đợt 1–2 đang chạy). Phần A–C viết cho người dùng; phần D–G là thiết kế kỹ thuật, đường dẫn tính từ `packages\`.

---

## A. Tóm tắt một trang

**Bạn nhận được gì**

| Đợt | Bạn dùng được |
|---|---|
| **3a — Nền PyTorch** | Máy chấm hiểu PyTorch · một sao mới "PyTorch căn bản" (4 bài) trong chòm Nền móng · công cụ kiểm bài soạn sẵn ngay trên Kaggle |
| **3b — Bộ máy paper** | Bài "thí nghiệm" (train thật trên Kaggle, máy chấm tự đo con số) · code của bạn từ bài trước tự đi theo sang bài sau · **tủ paper** thật (con số của bạn so với paper, ghi chú, chòm sao nhỏ) · paper mốc đầu tiên: *Attention Is All You Need* bản thu nhỏ, khép chòm Nền móng |
| **3c — Tự đưa paper vào** | Dán link arXiv (hoặc chọn file PDF) → mentor đọc, hỏi bạn 2 câu, đề xuất **kế hoạch reproduce** → bạn duyệt → mentor soạn bài (ẩn với bạn) → máy kiểm chứng từng bài → bạn làm từng bài như bài thường |
| **4 — Bốn nhánh** | 35 bài (phần lớn PyTorch) cho NLP/LLM, CV, mô hình sinh, RL (phủ hết 16 sao đang "chưa mở" trên bản đồ) · 6 paper mốc soạn sẵn: LoRA, ResNet, ViT, DDPM, DQN, PPO · chọn "nhánh trọng tâm" để bài hôm nay đi theo nhánh đó |

**Ý chính của thiết kế: một bộ máy, hai cách dùng.** Paper bạn tự đưa vào (AI soạn, đợt 3c) và paper mốc soạn sẵn (đợt 4) dùng **cùng một định dạng** và cùng đường chạy. Đợt 3 xây bộ máy và chứng minh nó bằng một paper soạn tay; đợt 4 chủ yếu là nội dung.

**Bốn nguyên tắc cũ vẫn giữ nguyên**: tay bạn gõ mọi dòng code của phần cần học · máy chấm (không phải AI) quyết định đúng sai · mỗi buổi ≤ 40 phút xong một việc trọn vẹn · con số tính từ nhật ký, không do AI tự khai.

**Năm quyết định cần bạn chốt** (mỗi cái có đề xuất; chi tiết ở mục G):

1. Thứ tự làm các nhánh ở đợt 4. *Đề xuất: NLP/LLM → mô hình sinh → CV → RL.*
2. Bài do AI soạn có tính rating không. *Đề xuất: có, nhưng chỉ đổi rating bằng một nửa bài soạn sẵn.*
3. Paper bạn tự đưa vào hiện ở đâu. *Đề xuất: chòm sao nhỏ nằm trong tủ paper, không chen vào bản đồ chính.*
4. Mentor soạn bài lúc nào. *Đề xuất: soạn hết ngay sau khi bạn duyệt kế hoạch (15–30 phút chạy nền).*
5. Phần code "cho sẵn" trong paper (tải dữ liệu, vẽ hình, boilerplate). *Đề xuất: cho phép, nhưng phải ghi rõ trong kế hoạch và bạn duyệt.*

---

## B. Đợt 3 — trải nghiệm

### B.1 Thêm một paper

1. Mở một notebook Kaggle trong Chrome (như khi làm bài). Notebook này là **xưởng** của paper: nơi mentor đọc paper, và nơi máy chạy thử các bài mentor soạn.
2. Trang Mentor → **Tủ paper** → **＋ Thêm paper**. VS Code hỏi: dán link/id arXiv, hoặc chọn một file PDF trên máy.
3. Chọn notebook làm xưởng (cùng danh sách chọn notebook như khi bắt đầu bài).
4. Bridge lấy nội dung paper (10–40 giây, có dòng "Đang lấy paper…"), ghi vào xưởng vài cell: tên paper, link, chỗ để kế hoạch hiện ra. Bản sao của xưởng mở trong VS Code, khung chat bên cạnh ở chế độ **lập kế hoạch**.

Nguồn nội dung, theo thứ tự ưu tiên: **mã LaTeX gốc của arXiv** (công thức nguyên vẹn, đây là điểm quan trọng nhất với người kẹt ở "công thức → code") → bản đọc của alphaXiv qua `orx paper` (nếu máy có orx) → chữ rút từ PDF (công thức dễ vỡ; mentor sẽ nói rõ và nhờ bạn đối chiếu với PDF).

### B.2 Lập kế hoạch (một buổi, 10–20 phút)

Mentor không đưa kế hoạch ngay. Nó hỏi bạn hai câu:

- **Bạn muốn gì ở paper này?** Hiểu phương pháp / ra được con số chính ở mức thu nhỏ / dùng làm nền cho nghiên cứu của bạn.
- **Bạn dành bao nhiêu buổi?** (mặc định 5–8 buổi)

Rồi nó đề xuất kế hoạch, hiện thành **thẻ kế hoạch** trong chat, trong xưởng, và trên tủ paper:

```
Kế hoạch reproduce · Denoising Diffusion Probabilistic Models (Ho et al., 2020)
Mục tiêu       Train một DDPM tí hon sinh chữ số; hiểu vì sao loss chỉ là "đoán nhiễu"
Nên vững trước ★ Vòng lặp train · ★ conv2d · ★ PyTorch căn bản        (bạn thiếu: conv2d)

 #  Thành phần                      Loại          Trích       ~phút  Độ khó
 1  Forward process q(x_t | x_0)    công thức     Eq. 4        20     1600
 2  Noise schedule β_t, ᾱ_t         tự dựng       §4, Eq. 4    15     1550
 3  Loss đơn giản L_simple          tự dựng       Eq. 14       25     1750
 4  U-Net tí hon                    cho sẵn       App. B        —       —
 5  Một bước reverse p_sample       tự dựng       Alg. 2       25     1850
 6  Train trên MNIST, T=200         thí nghiệm    Alg. 1       30     1800

Con số để so   Paper: FID 3.17 trên CIFAR-10 (Bảng 1)
               Bản thu nhỏ: L_simple trên tập kiểm tra ≤ 0.05; ảnh mẫu đọc ra chữ số
Máy            GPU T4 · train ≈ 8 phút · cần bật Internet trong notebook (tải MNIST)
Tổng           5 buổi

[ Duyệt kế hoạch ]   (muốn sửa thì nói với mentor trong chat)
```

- Bạn mặc cả trong chat: bỏ, gộp, tách thành phần; đổi "cho sẵn" ↔ "tự dựng"; đổi dữ liệu; rút ngắn. Mỗi lần mentor sửa, thẻ kế hoạch cập nhật.
- **"Cho sẵn"** là code bạn không phải gõ: tải dữ liệu, vẽ hình, và phần boilerplate không thuộc ý tưởng của paper. Mọi thứ thuộc ý tưởng của paper mặc định là "tự dựng". Bạn thấy rõ ranh giới này trước khi duyệt.
- Thí nghiệm thu nhỏ bị giới hạn: train ≤ 15 phút trên máy Kaggle, để vừa một buổi.
- Bridge từ chối kế hoạch không hợp lệ (không có thí nghiệm, quá 10 thành phần, thành phần dùng một thành phần chưa khai báo…); mentor phải sửa trước khi bạn thấy nút Duyệt.
- Duyệt xong, buổi lập kế hoạch được tính là một ngày học (chuỗi ngày +1).

### B.3 Mentor soạn bài (chạy nền, bạn không thấy nội dung)

Sau khi duyệt, thẻ **Đang soạn bài** hiện tiến độ:

```
Soạn bài cho DDPM                                         [ Dừng ]
 ✓ 1 Forward process        đã kiểm chứng (lời giải qua 6/6 test, bắt được 4/4 bản sai)
 ✓ 2 Noise schedule         đã kiểm chứng
 ⟳ 3 Loss đơn giản          đang kiểm chứng lần 2 (lần 1: một bản sai lọt qua test)
 · 4 U-Net tí hon           chờ
 …
```

- Việc soạn diễn ra trong một **phiên ẩn**: lời giải mẫu, bộ test, các bản cố tình sai không bao giờ hiện trong chat của bạn. Bạn chỉ thấy tiến độ và lý do ngắn khi hỏng.
- **Máy kiểm chứng từng bài** trước khi bạn được làm (chi tiết ở D.5). Bài không qua sau 3 vòng sửa thì đánh dấu "chưa soạn được", bạn chọn: soạn lại, hoặc chuyển thành "cho sẵn", hoặc bỏ.
- Xưởng cần mở và máy Kaggle cần bật trong lúc soạn (khoảng 15–30 phút cho cả paper). Đóng giữa chừng thì lần sau mở lại xưởng, bấm **Soạn tiếp**: bài đã kiểm chứng không soạn lại.
- Trong lúc chờ, bạn làm bài hôm nay ở một notebook khác được.

### B.4 Làm từng thành phần

Mỗi thành phần là một bài như bài thường (Phòng công thức → Dựng → Bảo vệ, thang gợi ý, Chấm bài, rating, ôn ngắt quãng), chép vào notebook bạn chọn. Khác ba điểm:

- **Đề bài trích đúng chỗ trong paper** ("Eq. 14, mục 3.4"). Ở Phòng công thức, mentor bắt bạn lập **bảng ký hiệu → tensor**: mỗi ký hiệu trong công thức là tensor nào, shape gì. Đây là bài thuốc cho "không rút được trực giác từ công thức".
- **Code của bạn đi theo bạn.** Bài 5 cần hàm của bài 2 và 3: notebook có sẵn một cell "Code của bạn từ các bài trước" chứa đúng những gì bạn đã gõ và đã qua máy chấm (kèm phần cho sẵn). Máy chấm bài 5 chạy code của bạn trên nền chính code đó, không phải trên lời giải mẫu.
- **Báo bài sai**: bài do AI soạn có nút này. Bạn nói chỗ nghi sai (đề lệch paper, test vô lý); lượt làm đó bị hủy khỏi rating, mentor soạn lại bài trong xưởng.

### B.5 Bài thí nghiệm (thành phần cuối)

1. **Dự đoán trước**: bạn viết vào cell dự đoán: loss sẽ đi thế nào, con số cuối khoảng bao nhiêu, vì sao bản thu nhỏ lệch paper.
2. **Chạy**: notebook có code của bạn + cell cấu hình cho sẵn + cell train. Bạn bấm chạy; train vài phút trên Kaggle. Xong, chat hiện thẻ "Train xong (7 phút) — bấm Chấm bài".
3. **Chấm bài kiểu thí nghiệm**: máy chấm không chạy lại code của bạn từ đầu (sẽ phải train lại) mà **tự đo trên mô hình đang nằm trong máy**: tính loss/accuracy trên dữ liệu kiểm tra do chính bộ test tạo. Con số là do máy đo, không phải bạn hay AI khai.
4. **Bảo vệ**: so dự đoán với thực tế, so con số của bạn với paper, giải thích khoảng lệch. Cuối cùng bạn tự viết **ghi chú 5 câu**: paper làm gì, mấu chốt, mình ra được gì, lệch ở đâu, muốn thử gì tiếp. Ghi chú này lên tủ.

Máy Kaggle tắt giữa chừng thì mô hình mất: bạn chạy lại các cell (vì vậy train bị giới hạn 15 phút).

### B.6 Tủ paper

Mỗi paper là một thẻ; bấm vào ra trang chi tiết.

```
📜 DDPM · Ho et al. 2020                    ● Đang làm 3/6        [ Làm tiếp ▶ ]
   ✦──✦──✦──○──○──◎                         (chòm sao nhỏ: mỗi thành phần một sao, sao cuối là thí nghiệm)
   Con số        Paper (CIFAR-10)    Bạn (MNIST thu nhỏ)
   L_simple      —                   0.041
   FID           3.17                không đo
   Ghi chú của bạn: "DDPM học đoán nhiễu đã thêm vào ảnh…"
```

- Trạng thái: Đang lập kế hoạch · Đang soạn bài 3/6 · Sẵn sàng · Đang làm 2/6 · **Đã reproduce** (thẻ sáng lên, chòm sao nối đủ).
- Trang chi tiết: kế hoạch với trạng thái từng thành phần và nút Bắt đầu/Làm tiếp, bảng con số, ghi chú (sửa được), **Mở xưởng** (sửa kế hoạch, soạn lại), **Đặt làm trọng tâm**, **Cất paper** (ẩn khỏi tủ; lịch sử và rating giữ nguyên).
- **Trọng tâm**: khi một paper là trọng tâm, "Bài hôm nay" trên trang chủ là thành phần kế tiếp của paper đó. Bỏ trọng tâm thì quay về lộ trình bản đồ. Khởi động (ôn bài cũ) vẫn như cũ.
- Paper mốc soạn sẵn (đợt 3b, 4) nằm cùng tủ, có nhãn "Paper mốc của chòm …", và hiện thành **sao lớn cuối chòm** trên bản đồ chính.

---

## C. Đợt 4 — trải nghiệm và nội dung

### C.1 Bạn thấy gì khác

- 16 sao của bốn nhánh hết "chưa mở". Bấm tên một chòm trên bản đồ → **Đặt làm trọng tâm**: bài hôm nay ưu tiên chòm đó (và các sao nền nó cần). Không đặt thì bài hôm nay chọn như bây giờ.
- Bài nhánh viết bằng PyTorch. Sao "PyTorch căn bản" (đợt 3a) là cửa vào: các sao đầu nhánh nối sau nó.
- Mỗi chòm khép bằng paper mốc: các sao của chòm chính là các thành phần của paper, nên làm xong các sao thì paper mốc chỉ còn phần ráp và thí nghiệm.

### C.2 Danh sách bài (độ khó trong ngoặc; ✎ = biến thể có bước dự đoán)

**Nền móng — sao mới "PyTorch căn bản"** (đợt 3a)
`torch-tensor-ops` broadcasting/gather/einsum viết lại bằng torch (1300) · `torch-autograd` requires_grad, backward, no_grad, detach (1400) · `torch-module` tự viết Linear và MLP bằng nn.Module (1450) · `torch-trainloop` zero_grad/step, train/eval, device (1500)

**NLP/LLM** — sao BPE · GPT thu nhỏ · LoRA
`bpe-train` học bảng merge (1500) · `bpe-encode` encode/decode (1450) · `causal-attention` mask tam giác (1650) · `gpt-mini` ráp embedding + block + lm head, loss lệch một vị trí (1800) · `gpt-generate` temperature, top-k (1600) · ✎ `gpt-temperature` (1600) · `lora-linear` A, B, α/r, đóng băng trọng số gốc (1750) · ✎ `lora-merge` gộp trọng số (1700)
Paper mốc: *Attention Is All You Need* thu nhỏ (đảo chuỗi ký tự; khép **Nền móng**, làm ở đợt 3b) · *LoRA* (fine-tune GPT mini với r=4: % tham số train và loss so với fine-tune toàn bộ)

**CV** — sao Khối ResNet · Patch embedding · Contrastive loss
`batchnorm2d` train/eval, running stats (1550) · `residual-block` shortcut có projection (1600) · `patch-embed` unfold = conv stride p (1600) · `vit-forward` cls token, pos emb, encoder (1800) · `info-nce` NT-Xent của SimCLR (1750) · ✎ `info-nce-temperature` (1700)
Paper mốc: *ResNet* trên CIFAR-10 (mạng 20 lớp có và không có shortcut: thấy lại hiện tượng "degradation") · *ViT* thu nhỏ (ảnh hưởng của patch size)

**Mô hình sinh** — sao VAE/ELBO · GAN · DDPM · Flow matching
`reparam-kl` reparameterization + KL dạng đóng (1650) · `vae-elbo` (1700) · `gan-losses` loss của D, loss non-saturating của G (1700) · ✎ `gan-saturating` (1700) · `noise-schedule` (1600) · `q-sample` (1650) · `ddpm-loss` (1750) · `p-sample` (1850) · `flow-matching-loss` (1800) · `euler-sampler` (1700)
Paper mốc: *DDPM* trên MNIST (U-Net tí hon cho sẵn)

**RL** — sao Bandit · Q-learning bảng · DQN · REINFORCE · GAE · PPO
`eps-greedy-bandit` (1300) · ✎ `ucb-bandit` (1400) · `q-learning-update` + vòng lặp gridworld (1500) · `replay-buffer` (1500) · `dqn-td-loss` target net, gather theo action, mask done (1750) · `returns-to-go` (1450) · `reinforce-loss` có baseline (1700) · `gae` (1800) · ✎ `gae-lambda` (1750) · `ppo-clip-loss` (1900) · `ppo-update` minibatch, value loss, entropy (2000)
Paper mốc: *DQN* trên CartPole · *PPO* trên CartPole (môi trường CartPole thuần numpy cho sẵn, không cần cài gym)

Tổng: 4 + 8 + 6 + 10 + 11 = **39 bài** và **7 paper mốc**. Mỗi bài đủ bộ như đợt 1–2: đề, cell hình Phòng công thức, starter, lời giải chuẩn, test ẩn, ≥ 3 bản cố tình sai, ngân hàng câu hiểm.

### C.3 Cách sản xuất nội dung

Như đợt 1–2: nhiều subagent viết song song, mỗi bài phải qua bài kiểm tự động của catalog. Khác: bài PyTorch **không kiểm được trên máy bạn** (máy không có PyTorch, và bạn không muốn cài). Vì vậy đợt 3a thêm lệnh kiểm bài ngay trên một notebook Kaggle đang mở (D.6); kết quả ghi vào `mentor-catalog/verified.json`, và bài kiểm tự động từ chối mọi bài PyTorch chưa có dấu đã kiểm (hoặc đã sửa sau khi kiểm).

Mỗi đợt nội dung cần bạn mở sẵn một notebook Kaggle (CPU là đủ) khoảng 20–30 phút để mình chạy kiểm.

---

## D. Thiết kế kỹ thuật — bộ máy chung (3a, 3b)

### D.1 Định dạng bài: thêm vào `meta.json` (`bridge/src/mentor/catalog.ts`)

```jsonc
{
  // … các trường hiện có …
  "paper": "ddpm",                 // bài thuộc paper nào (không có = bài lộ trình)
  "role": "formula" | "component" | "experiment",   // mặc định "component"
  "cites": "Eq. 14, §3.4",         // hiện trong đề và trong playbook của mentor
  "uses": ["noise-schedule", "q-sample"],   // bài phải có code trước (của bạn, đã qua máy chấm)
  "judge": "source" | "kernel",    // mặc định "source"; "kernel" cho thí nghiệm
  "judgeSeconds": 60,              // tối đa 600 (thí nghiệm đo trên mô hình)
  "author": "curated" | "ai",      // "ai": rating đổi một nửa (K × 0.5)
  "metrics": [{ "name": "L_simple", "paper": "—", "unit": "" }]   // con số thí nghiệm báo về
}
```

- File mới tùy chọn trong thư mục bài: `given.py` (code cho sẵn, hiện trong notebook, chạy trước code của bạn trong máy chấm).
- `uses` phải là đồ thị không vòng; bài có `uses` chỉ bắt đầu được khi mọi bài nó dùng đã có lời giải lưu (D.3). Bài `role: "experiment"` không có ôn ngắt quãng (`scheduleReview` bỏ qua) và dùng luồng "dự đoán" sẵn có của biến thể (`predict`).

### D.2 Gói paper

```
mentor-catalog/papers/<paperId>/          (paper mốc, đi kèm sản phẩm)
~/.agent-in-notebook/mentor/papers/<paperId>/   (paper của bạn)
  paper.json      tên, tác giả, năm, link, nguồn, kế hoạch (D.7), trạng thái từng thành phần, chòm (paper mốc)
  source.md       nội dung paper đã lấy về (chỉ paper của bạn)
  notes.md        ghi chú của bạn
  exercises/<exerciseId>/…   đúng định dạng thư mục bài hiện có
  drafts/<exerciseId>/…      bài đang soạn, chưa kiểm chứng (không bao giờ được nạp vào catalog)
  verify/<exerciseId>.json   biên bản kiểm chứng (D.5)
```

- `exerciseId` của paper bạn đưa vào: `<paperId>--<slug>` (hợp regex id hiện có, không đụng bài soạn sẵn).
- **Catalog gộp** (`Mentor.catalog`): bài soạn sẵn (nạp một lần) + bài của các gói paper. Phần gói paper của bạn nạp lại khi `PaperShelf` báo thay đổi. Chỉ bài nằm trong `exercises/` **và** có biên bản kiểm chứng khớp hash mới được nạp.
- Mỗi gói paper sinh một chòm ảo `constellation: "paper:<paperId>"`, mỗi thành phần "tự dựng" là một sao (id = exerciseId, `after` = `uses`). Nhờ vậy `starStates`, `starFade`, `home()` chạy nguyên; `MentorConstellation` thêm `kind: "map" | "paper"` để giao diện tách bản đồ chính với tủ paper. Paper mốc khai `closes: "<constellationId>"` để vẽ sao lớn cuối chòm.

### D.3 Code đi theo bài (`uses`)

- Khi một lượt chấm **đạt**, `Chat.judge` lưu nguồn các cell lời giải vào `mentor/solutions/<exerciseId>.py` (bản đạt mới nhất; cũng lưu cho bài lộ trình, vì paper mốc dùng lại bài của các sao).
- `exerciseCells` của bài có `uses`: sau đề, thêm một cell code đầu là `#| mentor: carried`, gồm `given.py` của các bài phụ thuộc và lời giải đã lưu của bạn, theo thứ tự tô-pô. `cellRole` thêm vai `carried`; cell này không thuộc `LearnerWork` (luôn dựng lại từ kho).
- Máy chấm (`judgeCode`) nhận thêm `before`: namespace của bạn = prelude + given + code đã lưu của các bài `uses` + cell bài làm. Namespace tham chiếu = prelude + given + lời giải chuẩn của các bài `uses` + lời giải chuẩn của bài. Test vẫn là `test_*(user, ref)`.
- Thiếu lời giải lưu của một bài phụ thuộc (bạn chưa làm, hoặc làm ở thời chưa có tính năng này): `mentor.start` từ chối bằng "Làm bài X trước" kèm nút mở bài X.

### D.4 Máy chấm: PyTorch và kiểu thí nghiệm (`bridge/src/mentor/judge.ts`)

- **Thư viện test dùng chung** tiêm vào namespace test dưới tên `t` (không nằm trong notebook): `t.seed(n)` (random, numpy, torch), `t.close(a, b, tol)`, `t.shape(x, (…))`, `t.grad_close(…)`, `t.load_into(module, ref_module)` (chép trọng số theo tên tham số), `t.report(name, value)`. Viết sao cho không cần torch khi bài không dùng torch.
- Quy ước bài PyTorch (ghi vào hướng dẫn soạn bài): ưu tiên hàm thuần nhận tensor; bài `nn.Module` cố định tên thuộc tính trong đề và starter để test chép trọng số; test chạy trên CPU, float32, sai số 1e-5 (1e-4 cho phép tính dồn).
- **`judge: "kernel"`**: harness không `exec` lại nguồn; `user` là namespace đang sống của kernel (`globals()` của lời gọi `execute`). Test tự tạo dữ liệu kiểm tra và tự đo trên `user["model"]`, rồi `t.report("test_acc", acc)`. Không có `ref` chạy lại; ngưỡng đạt nằm trong test.
- `MentorVerdict` thêm `metrics?: { name: string; value: number }[]`; sự kiện `judge` trong nhật ký thêm `metrics`. Bảng con số trên tủ paper gộp từ lượt chấm đạt mới nhất của bài thí nghiệm.
- Thời gian chờ lấy từ `judgeSeconds` thay cho hằng `JUDGE_WAIT_MS`.
- Thẻ "chạy xong" cho cell chạy lâu được bật lại trong chat mentor khi bài là thí nghiệm (`chat.ts`, chỗ `long && !this.mentor`), với nút Chấm bài.

### D.5 Kiểm chứng một bài (`bridge/src/mentor/verify.ts`, mới)

`verifyExercise(ex, exec)` chạy trong kernel của một notebook đang nối, trả biên bản. Dùng cho **cả** bài AI soạn (bắt buộc, lúc chạy) và bài soạn sẵn dùng PyTorch (lúc phát triển). Một bài đạt khi:

| # | Điều kiện |
|---|---|
| 1 | `meta.json`, `probes.json` hợp lệ theo zod; ≥ 4 test, mỗi test có nhãn; số câu hiểm ≥ `probes` + 1 |
| 2 | Thư viện trong `requires` có trên máy |
| 3 | Lời giải chuẩn qua **mọi** test, hai lần liền (bắt test chập chờn do ngẫu nhiên) |
| 4 | Starter đầy đủ **trượt** |
| 5 | ≥ 3 bản cố tình sai; mỗi bản **chạy được** (không lỗi cú pháp/import) và trượt ít nhất một test |
| 6 | Lần chấm lời giải chuẩn ≤ 1/3 `judgeSeconds` |
| 7 | Các cell Phòng công thức chạy không lỗi (trong namespace riêng, matplotlib backend Agg) |
| 8 | Không dòng nào của lời giải chuẩn (dài > 25 ký tự, không có trong starter/lab/given) lọt vào các cell của notebook (kiểm thuần TS, như test catalog hiện có) |
| 9 | Bài thí nghiệm: `judgeSeconds` ≤ 600, có ≥ 1 `metrics`, kế hoạch khai thời gian train ≤ 15 phút. Điều kiện 3–5 thay bằng: test **trượt** trên một mô hình chưa train (cùng kiến trúc, trọng số khởi tạo) |

Biên bản `verify/<exerciseId>.json`: thời điểm, phiên bản Python/torch, kết quả từng điều kiện, hash các file của bài. Sửa bất kỳ file nào làm hash lệch → bài không còn được nạp cho tới khi kiểm lại.

**Giới hạn phải nói thẳng:** máy chỉ xác nhận bài *tự nhất quán* (lời giải, test, bản sai khớp nhau), không xác nhận bài *đúng với paper*. Bốn lớp bù: đề trích đúng chỗ trong paper để bạn đối chiếu (chính là kỹ năng cần luyện) · nút Báo bài sai · thí nghiệm cuối là phép thử thật của cả chuỗi · rating bài AI soạn chỉ đổi một nửa.

### D.6 Kiểm bài soạn sẵn trên Kaggle (3a)

- Lệnh `ainb mentor verify [id…] [--tab N]` (`bridge/src/cli.ts`): nối vào bridge đang chạy bằng token sẵn có, gọi RPC mới `mentor.verify { exerciseIds?, tabId? }`, in biên bản, ghi `mentor-catalog/verified.json` (`{ [exerciseId]: { hash, python, torch, at } }`). Không có `--tab` thì dùng notebook duy nhất đang nối.
- `test/mentor-catalog.test.ts`: bài chỉ cần numpy vẫn chạy Python trên máy như cũ; bài có `torch` trong `requires` phải có mục trong `verified.json` với hash khớp, không thì test đỏ.
- Lệnh VS Code `ainb.mentor.verify` gọi cùng RPC (cho bạn bấm khi cần).

---

## E. Thiết kế kỹ thuật — tự đưa paper vào (3c)

### E.1 Sơ đồ

```
VS Code                          bridge (bridge/src/mentor)                       Chrome: notebook Kaggle (xưởng)
 Tủ paper: ＋ Thêm paper  ─────►  PaperShelf (papers.ts)   lấy nội dung (fetch.ts)
 chọn notebook làm xưởng  ─────►  MentorPlaces.workshop    ──insert_cell──►        cell <!-- mentor: paper <id> -->
 khung chat "lập kế hoạch" ─WS─►  Chat (workshop = WorkshopSession)
                                    agent + playbook <mentor-paper>, tool paper_source, paper_plan
 [Duyệt kế hoạch]         ─────►  WorkshopSession.approve
 thẻ "Đang soạn bài"      ◄─────  Author (author.ts): phiên agent ẨN, playbook <mentor-author>
                                    tool paper_exercise_write / _check  ──execute──► verify.ts trên kernel của xưởng
 Tủ paper cập nhật        ◄─────  mentor.updated
```

### E.2 Lấy nội dung paper (`fetch.ts`, mới)

| Nguồn | Cách lấy | Chạy ở đâu |
|---|---|---|
| arXiv (link hoặc id) | tải `arxiv.org/e-print/<id>` (tar.gz mã LaTeX), ghép file `.tex` chính và các file nó `\input`; kèm `arxiv.org/abs/<id>` cho tên, tác giả | bridge (Node: `fetch`, `zlib`, bộ đọc tar nhỏ tự viết; không thêm thư viện) |
| arXiv không có mã nguồn | `orx paper --full` (`Orx.cli`, chỉ cần orx được cài, không khởi động OpenResearch) | máy bạn |
| File PDF, hoặc hai cách trên đều hỏng | đẩy PDF lên máy Kaggle (`notebook/vmfs.ts: writeFile`), rút chữ bằng `pypdf` (thiếu thì `pip install`, cần Internet của notebook) | máy Kaggle |

Kết quả ghi `papers/<id>/source.md` kèm dòng đầu nói nguồn nào (để mentor biết công thức có đáng tin không). Giới hạn 600 000 ký tự. Agent đọc qua tool `paper_source { offset }` theo trang 40 000 ký tự, không phụ thuộc orx lúc đọc.

### E.3 Xưởng là một thuộc tính nữa của chat notebook

- Dấu cell: `<!-- mentor: paper <paperId> -->` ở cell đầu. `foreignCells` coi notebook xưởng là của Mentor; `mentor.places` thêm `workshop?: { paperId, title }`.
- Sự kiện mới `{ t: "workshop", paperId, notebook }`; `fold` giữ `state.workshops: Map<notebookKey, paperId>`. Một notebook hoặc chứa một bài, hoặc là một xưởng: ghi cái này xóa cái kia. Transcript của xưởng cất dưới khóa `mentor-paper:<paperId>` khi notebook bị dùng vào việc khác, quay lại khi mở xưởng lần nữa (cùng cơ chế `attemptChatKey`).
- `server.ts: mentorSession` trả thêm `WorkshopSession` khi khóa notebook là một xưởng; `Chat` nhận `opts.workshop`. Chat xưởng dùng `MENTOR_SETTINGS`, không project, không polling máy, như chat mentor.
- `WorkshopSession` (`workshop.ts`): trạng thái `reading → planning → approved → authoring → ready` (và `failed` theo từng thành phần). Luật: chỉ duyệt được kế hoạch hợp lệ; chỉ soạn sau khi duyệt; sửa kế hoạch sau khi duyệt chỉ đụng các thành phần chưa có lượt làm nào.

### E.4 Agent lập kế hoạch (`paper-prompt.ts`, `paper-tools.ts`)

- Playbook `<mentor-paper>`: hỏi mục tiêu và số buổi trước; đọc paper bằng `paper_source`; mỗi thành phần phải trích chỗ trong paper; phần thuộc ý tưởng paper là "tự dựng"; thí nghiệm ≤ 15 phút và dùng dữ liệu trong danh sách cho phép; **không viết code lời giải trong chat**; nói tiếng Việt, giữ thuật ngữ tiếng Anh.
- Tool của chat xưởng: `kernel_state`, `run_code`, `wait_for_code`, `read_output`, `interrupt_kernel`, `paper_source`, `paper_plan`. Chat xưởng không có tool soạn bài.
- Dữ liệu cho phép (kiểm được trước khi duyệt): dữ liệu tự sinh · `sklearn.datasets` có sẵn trong gói (digits, moons…) · torchvision MNIST/FashionMNIST/CIFAR-10 (cần Internet) · văn bản nhỏ nhúng trong `given.py` · môi trường RL thuần numpy cho sẵn. `paper_plan` chạy một phép thử nhỏ trên kernel (có Internet không, có GPU không) và ghi kết quả vào kế hoạch.

`paper_plan` nhận (bridge kiểm bằng zod, từ chối kèm lý do để agent sửa):

```ts
{
  title, authors, year,
  goal: string,                       // 1–2 câu
  requires: string[],                 // id các sao nền
  components: [{                      // 3..10; cuối cùng là experiment
    slug, title, role, mode: "build" | "given",
    cites: string, why: string,
    functions: string[],              // tên + chữ ký + shape: giao diện cố định cho cả chuỗi
    uses: string[], minutes: 10..40, difficulty: 800..2400, skills: MentorSkill[1..3]
  }],
  experiment: { dataset, device: "cpu" | "gpu", trainMinutes: 1..15,
                metrics: [{ name, paper: string, where: string, target: { op: ">=" | "<=", value: number } }] }
}
```

Độ khó do AI đề xuất bị kẹp trong [rating hiện tại − 300, rating hiện tại + 500] và hiện trong thẻ kế hoạch; playbook đưa các bài soạn sẵn làm mốc (LayerNorm 1350, scaled dot-product attention 1550, Transformer block 1850).

### E.5 Phiên soạn bài ẩn (`author.ts`, mới)

- Sau `mentor.paper.approve`, hoặc khi bấm Soạn tiếp, bridge mở một `Chat` **không gắn giao diện** trên cùng tab xưởng: `ChatHost.emit` là hàm rỗng, không nằm trong `chatsOn`/`chats.list`, transcript lưu dưới khóa `mentor-author:<paperId>` (để gỡ lỗi; không hiện ở đâu trong giao diện). Cùng agent với chat xưởng. `notebookOnly` bật nên mọi yêu cầu dùng tool riêng của agent (shell, ghi file) tự bị từ chối.
- Trong lúc soạn, chat xưởng giữ một `busyJob` (thẻ tiến độ có nút Dừng): hai chat không tranh kernel; tin nhắn bạn gửi được xếp hàng.
- Vòng lặp, tuần tự theo thứ tự tô-pô, mỗi thành phần tối đa 3 vòng:
  1. Bridge gửi lượt: kế hoạch, thành phần cần soạn, giao diện hàm, lời giải chuẩn của các thành phần nó dùng, hướng dẫn soạn bài (định dạng thư mục, quy ước D.4, ví dụ một bài soạn sẵn).
  2. Agent ghi file bằng `paper_exercise_write { component, file, content }` vào `drafts/`; thử nháp bằng `run_code`.
  3. Agent gọi `paper_exercise_check { component }`: bridge chạy `verifyExercise`, trả biên bản (điều kiện nào hỏng, test nào, bản sai nào lọt).
  4. Đạt: bridge chuyển `drafts/<id>` → `exercises/<id>`, ghi biên bản, nạp lại catalog, phát `mentor.updated`. Hỏng sau 3 vòng: thành phần `failed` kèm lý do một dòng.
- Thành phần "cho sẵn": agent chỉ viết `given.py` + một `tests.py` nhỏ kiểm nó chạy; kiểm chứng rút gọn (điều kiện 2, 7).
- Tool của phiên soạn: `kernel_state`, `run_code`, `wait_for_code`, `read_output`, `interrupt_kernel`, `paper_source`, `paper_plan_read`, `paper_exercise_write`, `paper_exercise_read`, `paper_exercise_check`.
- Agent coach của từng bài là một phiên **khác** (chat mentor thường): nó chỉ nhận đề, ngân hàng câu hiểm, và lời giải ở gợi ý mức 4, đúng như bài soạn sẵn.

### E.6 Nhật ký và con số (`model.ts`)

| Sự kiện mới | Tác dụng khi gộp |
|---|---|
| `{ t: "paper", paperId, what: "planned" \| "done" }` | tính ngày học; mốc thời gian trên tủ |
| `{ t: "workshop", paperId, notebook }` | bảng notebook → xưởng |
| `judge` thêm `metrics` | bảng con số của paper |
| `{ t: "void", attemptId, reason }` | lượt làm bị hủy: không vào rating, không hẹn ôn (ngày học vẫn tính). `fold` quét trước tập lượt bị hủy |

- Sự kiện không thuộc lượt làm mang `attemptId: "paper:<paperId>"` để bridge cũ đọc nhật ký mới không vỡ (bộ đọc hiện đòi `attemptId` là chuỗi và bỏ qua loại sự kiện lạ).
- `K` nhân 0,5 cho bài `author: "ai"` (cùng cơ chế `REVIEW_K`).
- Paper xong khi mọi thành phần "tự dựng" đã xong và bài thí nghiệm đạt.
- **Trọng tâm**: `profile.json` giữ `focus: { kind: "paper" | "constellation", id } | null`. `pickToday`: làm tiếp bài dở → chẩn đoán → làm lại sau khi xem lời giải → **bài kế của trọng tâm** → biến thể → bài kế trên bản đồ. `MentorToday.reason` thêm `"paper"` và `"focus"`.

### E.7 Giao thức (chỉ thêm, vẫn `WIRE_VERSION = 5`; extension Chrome không đổi)

```ts
MentorHome.papers: MentorPaper[]                // tóm tắt cho tủ
MentorHome.focus?: { kind, id, title }
MentorPaper { id, title, authors?, year?, url?, origin: "curated" | "yours", closes?: string,
              status: "reading" | "planning" | "authoring" | "ready" | "learning" | "done" | "archived",
              components: { id, title, role, mode, cites?, minutes, difficulty,
                            status: "planned" | "authoring" | "failed" | "ready" | "learning" | "done", why?: string }[],
              results: { name, paper?: string, yours?: number, unit?: string }[],
              notes?: string, place?: { tabId, title } }
ChatSnapshot.workshop?: { paperId, title, status, plan?, authoring?: { done, total, current?, note? } }
MentorChat.paper?: { paperId, title, index, total, cites? }        // bài thuộc paper
MentorVerdict.metrics?

Methods  mentor.paper.add { source: { arxiv } | { pdfPath }, tabId, replace? } → { paperId, tabId }
         mentor.paper.get · approve · author (soạn / soạn tiếp / soạn lại một thành phần) · stopAuthoring
         mentor.paper.notes · focus · archive · report { attemptId, reason } (báo bài sai)
         mentor.verify { exerciseIds?, tabId? }
Events   chat.workshop { chatId, tabId, workshop }   ·   mentor.updated (sẵn có)
```

### E.8 Giao diện

- `ui/src/mentor/home.tsx`: mục Tủ paper thành lưới thẻ (B.6) + trang chi tiết (trong cùng webview, không thêm tab); chòm sao nhỏ dùng lại bộ vẽ của `constellation.ts` với bố cục tự động theo `uses` (hàm thuần, có test). Sao lớn cuối chòm cho paper mốc trên bản đồ chính. Nút "Đặt làm trọng tâm" trên tên chòm và trên thẻ paper.
- `ui/src/mentor-bar.tsx`: với chat xưởng, thanh bước là Đọc paper · Kế hoạch · Soạn bài · Sẵn sàng, nút Duyệt kế hoạch / Soạn tiếp / Dừng; thẻ kế hoạch và thẻ tiến độ soạn. Với bài thuộc paper: dòng "Thành phần 3/6 · Eq. 14", nút Báo bài sai (hỏi lý do). Thẻ kết quả chấm hiện `metrics` khi có.
- `vscode/src/mentor-host.ts`: luồng Thêm paper (`showInputBox`, `showOpenDialog` cho PDF, chọn notebook như `pickPlace`), `mentor.paper.*` chuyển tiếp; `panel-core.ts` thêm method vào `BRIDGE_METHODS`, chuyển tiếp `chat.workshop`.

---

## F. Thứ tự làm, kiểm thử

### F.1 Các bước (mỗi dòng là một lần giao dùng được)

| Bước | Nội dung | File chính |
|---|---|---|
| **3a.1** | Thư viện test `t`, `judgeSeconds`, quy ước PyTorch | `mentor/judge.ts`, `catalog.ts` |
| **3a.2** | `verify.ts`, RPC `mentor.verify`, lệnh `ainb mentor verify`, `verified.json`, test catalog đòi dấu đã kiểm | `mentor/verify.ts`, `cli.ts`, `server.ts`, `test/mentor-catalog.test.ts` |
| **3a.3** | Sao "PyTorch căn bản" + 4 bài; nối các sao đầu nhánh sau nó | `mentor-catalog/map.json`, `exercises/torch-*` |
| **3b.1** | `uses`, `given.py`, lưu lời giải đạt, cell `carried`, máy chấm có `before` | `catalog.ts`, `notebook.ts`, `judge.ts`, `chat.ts`, `store.ts`, `place.ts` |
| **3b.2** | Bài thí nghiệm: `judge: "kernel"`, `metrics`, luồng dự đoán, thẻ train xong | `judge.ts`, `session.ts`, `prompt.ts`, `chat.ts`, `protocol/src/mentor.ts` |
| **3b.3** | Gói paper, catalog gộp, chòm ảo, trọng tâm, sự kiện `paper`/`void` | `mentor/papers.ts` (mới), `catalog.ts`, `model.ts`, `index.ts` |
| **3b.4** | Tủ paper và trang chi tiết, sao lớn cuối chòm, ghi chú | `ui/src/mentor/*`, `ui/mentor.css`, `vscode/src/mentor-host.ts` |
| **3b.5** | Paper mốc *Attention Is All You Need* thu nhỏ (soạn tay, kiểm trên Kaggle) | `mentor-catalog/papers/attention/` |
| **3c.1** | Lấy nội dung paper; xưởng (dấu cell, sự kiện, đặt vào notebook) | `mentor/fetch.ts`, `place.ts`, `model.ts`, `server.ts` |
| **3c.2** | Chat lập kế hoạch: `WorkshopSession`, playbook, `paper_source`, `paper_plan`, thẻ kế hoạch, Duyệt | `mentor/workshop.ts`, `paper-prompt.ts`, `paper-tools.ts`, `chat.ts`, `ui/src/mentor-bar.tsx` |
| **3c.3** | Phiên soạn ẩn, vòng kiểm chứng, thẻ tiến độ, Soạn tiếp | `mentor/author.ts`, `chat.ts`, `server.ts` |
| **3c.4** | Báo bài sai, soạn lại, cất paper; `docs/architecture.md` | `session.ts`, `model.ts`, UI |
| **4.x** | Mỗi nhánh một lần giao: các bài của nhánh + paper mốc, kiểm trên Kaggle; thứ tự theo quyết định 1 | `mentor-catalog/exercises/*`, `papers/*` |
| **4.cuối** | Chọn nhánh trọng tâm trên bản đồ (nếu chưa làm ở 3b.3), rà độ khó theo dữ liệu làm bài thật | `ui/src/mentor/home.tsx`, `meta.json` |

Sau mỗi bước: `pnpm typecheck`, `pnpm test`, đóng gói và cài lại VSIX.

### F.2 Kiểm thử tự động (không dùng agent thật, không cần Kaggle)

- `mentor-judge.test.ts`: harness có `before`; chế độ `kernel` (Python trên máy, numpy); `t.report` ra `metrics`; hết giờ theo `judgeSeconds`.
- `mentor-verify.test.ts`: từng điều kiện D.5 với một bài mẫu tốt và các bài mẫu hỏng (test chập chờn, bản sai lọt, bản sai không chạy được, lời giải lọt vào notebook, lab lỗi).
- `mentor-papers.test.ts`: kiểm kế hoạch (vòng trong `uses`, thiếu thí nghiệm, quá 10 thành phần, độ khó bị kẹp); gói paper nạp/không nạp theo biên bản và hash; catalog gộp; chòm ảo.
- `mentor-model.test.ts`: `void`, `metrics`, `K × 0.5`, thí nghiệm không hẹn ôn, trọng tâm trong `pickToday`, sự kiện `paper` tính ngày học, nhật ký mới đọc được bằng `fold` cũ (bỏ qua loại lạ).
- `mentor-paper-chat.test.ts` (đầu-cuối, `FakeExtension` + `fake-agent.mjs` có kịch bản): thêm paper từ một `source.md` giả → chat xưởng → `paper_plan` hỏng bị từ chối, hợp lệ thì hiện thẻ → duyệt → phiên soạn ẩn ghi bài, `paper_exercise_check` đạt/hỏng theo `execResult` giả → **không có sự kiện nào của phiên soạn tới editor, không dòng lời giải nào trong transcript của chat xưởng** → bài chưa kiểm chứng không bắt đầu được → làm bài 1, bài 2 có cell `carried` chứa đúng code bài 1 → bài thí nghiệm ghi `metrics` → tủ hiện con số → báo bài sai hủy lượt làm.
- `fetch.test.ts`: ghép LaTeX từ một tar.gz mẫu (file chính, `\input`), id arXiv dạng cũ và mới, nguồn hỏng thì rơi xuống cách kế.
- `ui/test`: bố cục chòm sao nhỏ, thẻ tủ paper. `vscode/test/panel-core.test.ts`: chuyển tiếp method mới.

### F.3 Chạy thật (cần bạn: Chrome, Kaggle)

1. `ainb mentor verify` trên một notebook Kaggle CPU: 4 bài PyTorch căn bản đạt; sửa một dòng test → test catalog đỏ.
2. Paper mốc Attention: làm một thành phần, thành phần sau có code của bạn; train bản thu nhỏ; Chấm bài đo được accuracy; tủ hiện con số.
3. Thêm một paper arXiv thật (đề xuất: DDPM, arXiv 2006.11239): lấy được LaTeX; kế hoạch hợp lý; duyệt; soạn xong ≥ 4/6 thành phần; trong chat của bạn không có lời giải.
4. Thêm một paper bằng PDF: đi đường rút chữ trên Kaggle.
5. Đóng xưởng giữa lúc soạn, mở lại, Soạn tiếp.
6. Tắt máy Kaggle giữa bài thí nghiệm: Chấm bài báo đúng "chạy lại các cell".

---

## G. Rủi ro, giới hạn, và các quyết định cần bạn

### G.1 Rủi ro và giới hạn đã biết

- **Bài AI soạn có thể sai so với paper** dù qua kiểm chứng (D.5). Đây là rủi ro lớn nhất của đợt 3c; bốn lớp bù đã nêu, không có lớp nào là tuyệt đối.
- **Chất lượng kế hoạch phụ thuộc agent bạn dùng.** Paper nặng toán hoặc cần dữ liệu/tính toán lớn có thể không thu nhỏ được trong 15 phút train; mentor phải nói thẳng và đề xuất reproduce một phần (một bảng, một hình).
- **Chi phí**: soạn một paper 6 thành phần là một phiên agent dài (ước 15–30 phút, tốn hạn mức của agent bạn đang dùng).
- **Phiên soạn ẩn không phải két sắt**: lời giải nằm trong thư mục `~/.agent-in-notebook/mentor/papers` trên máy bạn. Ẩn là để bạn không vô tình thấy, không phải để chống bạn.
- **Chấm kiểu thí nghiệm tin vào trạng thái kernel**: test tự đo trên mô hình, nhưng không chứng minh được mô hình đó do đúng code của bạn train ra. Chấp nhận, vì đây là công cụ tự học.
- **Kaggle**: tải dữ liệu cần bật Internet trong notebook (tài khoản đã xác minh số điện thoại); GPU có hạn mức theo tuần; máy tắt là mất mô hình.
- **Chưa kiểm chứng được từ code, kiểm ngay ở bước đầu của từng phần**: (a) một `Chat` thứ hai không giao diện trên cùng tab có chạy `execute` ổn không khi chat xưởng giữ `busyJob`; (b) `globals()` trong lời gọi `execute` trên Kaggle có đúng là namespace của người dùng; (c) Kaggle có sẵn `pypdf` không; (d) kích thước tối đa một lời gọi `execute` khi đẩy PDF lên. Nếu (a) không ổn, phương án lùi: soạn ngay trong chat xưởng với các lượt "che" (nội dung tool và chữ của agent trong lượt soạn không hiển thị).

### G.2 Ngoài phạm vi

Paper không có trên arXiv và không có PDF (trang web, slide) · reproduce cần nhiều GPU-giờ hoặc dữ liệu riêng · một agent thứ hai kiểm chéo bài AI soạn · chia sẻ gói paper giữa nhiều người · JAX/TensorFlow · nhắc học ngoài VS Code.

### G.3 Quyết định cần bạn (kèm đề xuất)

| # | Câu hỏi | Lựa chọn | Đề xuất và lý do |
|---|---|---|---|
| 1 | Thứ tự nhánh ở đợt 4 | bất kỳ hoán vị nào của NLP/LLM, CV, mô hình sinh, RL | **NLP/LLM → mô hình sinh → CV → RL**: NLP nối thẳng từ Transformer block bạn vừa học; nếu hướng nghiên cứu của bạn là nhánh khác thì đưa nhánh đó lên đầu |
| 2 | Rating của bài AI soạn | tính đủ · tính một nửa · không tính | **Một nửa**: độ khó do AI ước lượng chưa được hiệu chỉnh, nhưng không tính thì mất động lực |
| 3 | Paper của bạn hiện ở đâu | chòm nhỏ trong tủ paper · thêm vùng mới trên bản đồ chính | **Trong tủ**: bản đồ chính giữ ổn định, không phình theo số paper |
| 4 | Soạn bài lúc nào | soạn hết sau khi duyệt · soạn dần, luôn đi trước bạn một bài | **Soạn hết**: việc kiểm chứng cần kernel rảnh, soạn dần sẽ tranh kernel với lúc bạn đang làm bài. Đổi lại tốn hạn mức agent ngay cả khi bạn bỏ dở paper |
| 5 | Code "cho sẵn" | cho phép khi ghi rõ trong kế hoạch · cấm hẳn (bạn gõ mọi thứ) | **Cho phép**: gõ lại data loader và U-Net boilerplate ăn hết thời gian mà không dạy ý tưởng của paper |

Nếu bạn đồng ý cả năm đề xuất, thứ tự làm sẽ là 3a → 3b → 3c → 4 theo bảng F.1.
