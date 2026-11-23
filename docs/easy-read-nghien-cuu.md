# Easy-read — tổng hợp nghiên cứu

Nền cho thiết kế ở `docs/easy-read.md`. Tổng hợp ngày 23/11/2026 từ hai lượt nghiên cứu song song (phương pháp đọc paper và khoa học học tập; công cụ và nguyên mẫu đọc paper có AI). Mỗi nguồn ghi URL đã mở để đọc. **[chưa kiểm]**: chỉ thấy qua đoạn trích của máy tìm kiếm hoặc bài viết lại, chưa đọc bản gốc.

---

## 1. Phương pháp đọc paper

### 1.1 Keshav, "How to Read a Paper" (2007) — ba lượt
https://web.stanford.edu/class/ee384m/Handouts/HowtoReadPaper.pdf

| Lượt | Làm gì | Xong khi |
|---|---|---|
| 1 (5–10 phút) | Đọc kỹ tiêu đề, abstract, phần mở đầu; đọc tiêu đề các mục "bỏ qua mọi thứ khác"; đọc kết luận; lướt danh sách tham khảo, đánh dấu bài đã đọc | Trả lời được **5C**: *Category* (loại paper), *Context* (dựa trên paper/lý thuyết nào), *Correctness* (giả định có hợp lý), *Contributions* (đóng góp chính), *Clarity* (viết có rõ). Rồi quyết định có đọc tiếp không |
| 2 (tới 1 giờ) | Đọc cẩn thận nhưng bỏ chứng minh; ghi ý chính và ghi chú lề; soi hình (trục có nhãn? có error bar, ý nghĩa thống kê?); đánh dấu tham khảo chưa đọc | "Tóm được ý chính của paper, kèm chứng cứ, cho người khác". Còn mù mờ thì: gác lại, đọc kiến thức nền, hoặc sang lượt 3 |
| 3 (4–5 giờ với người mới) | "Cài đặt lại paper trong đầu": cùng giả định với tác giả, tự dựng lại, so sánh; "nhận diện và chất vấn mọi giả định trong mọi câu"; ghi ý tưởng cho việc sau | "Dựng lại được toàn bộ cấu trúc paper từ trí nhớ", chỉ ra giả định ngầm, trích dẫn thiếu, lỗi thực nghiệm/phân tích |

Khảo sát một lĩnh vực: 3–5 paper gần đây, mỗi bài một lượt, đọc phần related work; tìm bài survey; tìm trích dẫn chung và tác giả lặp lại; hai lượt trên tập đó rồi lặp.

### 1.2 Andrew Ng, CS230 Lecture 8 (2018) [bản tóm của người khác, không phải transcript]
https://www.kdnuggets.com/2019/09/advice-building-machine-learning-career-research-papers-andrew-ng.html

- 5–20 paper về một chủ đề đủ để cài đặt một hệ thống; 50–100 paper cho hiểu biết rất tốt về lĩnh vực. Lập danh sách, lướt song song 10–20 % mỗi bài, bỏ bớt, đọc kỹ một hai bài.
- Các lượt: tiêu đề + abstract + hình → mở đầu + kết luận + hình, lướt phần còn lại → cả bài bỏ toán → cả bài, chỉ bỏ chỗ chưa hiểu.
- Câu hỏi sau khi đọc: tác giả muốn đạt gì? yếu tố then chốt của cách làm? mình dùng được gì? muốn đọc tiếp tham khảo nào?
- Toán: "dẫn lại từ đầu". Code: chạy code gốc, rồi "cài lại từ đầu". Nhịp: ~1 giờ bài dễ, ≥ 3 giờ bài khó; "hai paper mỗi tuần trong một năm" hơn là nhồi.

### 1.3 Các hướng dẫn khác

- **Eisner**, https://www.cs.jhu.edu/~jason/advice/how-to-read-a-paper.html — lướt trước có ngân sách thời gian. Ghi chú lề: viết lại chỗ khó bằng lời mình, điền chi tiết thiếu (giả định, bước đại số, pseudo-code), **ghi kiểu cho từng đối tượng toán học**, tự nghĩ ví dụ minh họa và cả **ví dụ làm khó tác giả**. Đọc vài bài thật kỹ: biết "mỗi câu, mỗi chỉ số dưới đang làm gì", tự hỏi câu ngớ ngẩn và tự trả lời. Thí nghiệm có công bằng, có đỡ được claim, có tổng quát được? Mẹo của Rao: **"Đừng đọc paper gốc về X trước"** — đọc bản trình bày sau đó, kẹt thì về giáo trình/survey.
- **Mitzenmacher**, https://www.cs.princeton.edu/courses/archive/fall10/cos597B/papers/howtoread-mitzenmacher.pdf — đọc phê phán (đúng bài toán chưa? có lời giải đơn giản bị bỏ qua? hạn chế không thừa nhận? dữ liệu có đúng, diễn giải có hợp lý, "dữ liệu khác có thuyết phục hơn?"), đọc sáng tạo ("nếu bắt đầu nghiên cứu từ paper này, việc tiếp theo là gì?"). Sau lượt đầu, tóm paper trong 1–2 câu (câu hỏi + câu trả lời), rồi 3–4 ý phụ. Mẫu review một trang: tóm tắt · dàn ý (giả định, lập luận, dữ liệu, kết luận) · hạn chế và mở rộng · đánh giá chất lượng và tác động.
- **Griswold**, https://cseweb.ucsd.edu/~wgg/CSE210/howtoread.html — 8 câu hỏi (động cơ và vì sao lời giải trước chưa đủ; lời giải và vì sao nó tốt hơn; đánh giá; phân tích của bạn, ý gây tranh cãi nhất; đóng góp; hướng tiếp; câu hỏi còn lại; điều bạn mang về). **"Chưa trả lời hết thì chưa đọc xong."** Gắn nhãn đoạn: động cơ / lời giải / đánh giá / đóng góp. Tóm tắt 250 chữ "không phải viết lại abstract".
- **Carey, Steiner & Petri, "Ten simple rules…"** (PLOS Comp Biol 2020), https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1008032 — chọn mục tiêu đọc; nhận diện loại bài. **Sáu câu hỏi** cho cả bài và cho từng hình/bảng/thí nghiệm: tác giả muốn biết gì? đã làm gì? vì sao làm thế? kết quả cho thấy gì? tác giả diễn giải ra sao? nên làm gì tiếp? Mỗi hình: trục, màu, thống kê, vì sao chọn kiểu hình này, rồi **tự nói thông điệp chính**. Có cách giải thích khác cũng hợp lý không? "Mình thấy thuyết phục vì nó hợp ý mình sẵn?" Khoanh thuật ngữ lạ và tra thật. Giải thích ở nhiều mức: "dạy là học hai lần".
- **QALMRI** (Kosslyn & Rosenberg), https://www.crumplab.com/ResearchMethodsLab/qalmri.html — Question (rộng và cụ thể) · Alternatives (≥ 2 giả thuyết) · Logic ("nếu giả thuyết 1 đúng thì kết quả dự đoán là gì?") · Method (biến độc lập, phụ thuộc) · Results · Inferences (+ thí nghiệm tiếp theo). Hợp với phần thí nghiệm và ablation của paper ML. Bằng chứng trong lớp học [chưa kiểm].
- **Karpathy**, https://www.datascienceweekly.org/data-scientist-interviews/training-deep-learning-models-browser-andrej-karpathy-interview — "đọc một lần rồi tự cài lại từ đầu"; cảnh báo cảm giác hiểu vì mọi thứ "nghe hợp lý". Cách "ba lượt với LLM" của ông [chưa kiểm].
- Purugganan & Hewitt (Rice) [chưa kiểm, link 404]: đặt câu hỏi trước, trong và sau khi đọc. Kilcher, Lilian Weng, Saravia: không tìm thấy phương pháp viết thành văn.

### 1.4 Ghi nhớ một paper: Nielsen và Matuschak

- **Nielsen, "Augmenting Long-term Memory"**, https://augmentingcognition.com/ltm.html — đọc nông 10–60 phút/paper, rút **5–20 thẻ Anki** (chủ yếu từ abstract, mở đầu, kết luận, hình); không tìm được 5 thẻ tốt thì không thêm thẻ nào (một thẻ lẻ bị "mồ côi"). Claim ghi kèm nguồn ("Jones 2011 cho rằng…"), không ghi như sự thật. Với paper AlphaGo: nhiều lượt lướt nhanh "hút" các sự kiện dễ trước, mỗi lượt sâu hơn; sau 5–6 lượt mới đọc kỹ, rồi kỹ lần nữa; vài trăm thẻ trong vài ngày rải qua vài tuần; một năm sau đọc AlphaGo Zero và AlphaZero dưới một giờ. Thẻ: càng nguyên tử càng tốt, 2–3 thẻ mỗi ý, tránh câu có/không, tự viết thẻ (viết là mã hóa sâu). Ôn ~8 giây/lần, 15–20 phút/ngày.
- **Matuschak, "How to write good prompts"**, https://andymatuschak.org/prompts/ — thẻ tốt: *tập trung* (một chi tiết), *chính xác*, *nhất quán* (cùng đáp án mỗi lần), *trả lời được*, *cần gắng sức*. Loại: sự kiện, giải thích ("vì sao"), cloze (mỗi lần một mục của danh sách), quy trình, khái niệm (5 lăng kính: thuộc tính, giống/khác, phần/toàn thể, nhân/quả, ý nghĩa). Viết nhiều hơn cảm thấy tự nhiên. Bẫy: nhớ hình dạng câu hỏi thay vì nội dung, câu nhị phân, thiếu ngữ cảnh, gợi ý lộ đáp án.
- **Quantum Country**, https://numinous.productions/ttft/ — 112 thẻ nhúng trong bài, ôn trong bài, rồi sau 5 ngày, 2 tuần, 1 tháng…; 5 lần đúng thì cách 4 tháng. ~54 ngày nhớ được chứng minh mỗi thẻ sau ~95 phút ôn tổng, so với ~4 giờ đọc (chi phí thêm < 50 %). Tác giả tự nêu hạn chế: thí nghiệm nhỏ, tự chấm, người đọc nhớ dấu hiệu bề mặt, không tự viết thẻ.

### 1.5 Giải thích tương tác

- **Olah & Carter, "Research Debt"** (Distill 2017), https://distill.pub/2017/research-debt/ — nợ nghiên cứu: trình bày kém, ý chưa tiêu hóa, **ký hiệu và trừu tượng tồi ("giao diện người dùng của nghiên cứu")**, nhiễu. Chưng cất thường là "biến đổi ý tưởng"; "không giải thích tốt được thường là dấu hiệu chưa hiểu".
- **Bret Victor, "Explorable Explanations"**, http://worrydream.com/ExplorableExplanations/ — tài liệu phản ứng: người đọc thay giả định và thấy hệ quả; ví dụ khám phá được làm cái trừu tượng thành cụ thể, **phải gắn vào lời giải thích**, tác giả "giữ phần của mình trong cuộc trò chuyện", không "thả người đọc vào sandbox". Thông tin theo ngữ cảnh để người đọc tự kiểm claim.
- **Hohman et al., "Communicating with Interactive Articles"** (Distill 2020): chi tiết theo yêu cầu, sandbox tham số, "đoán trước khi xem", quiz nhẹ có phản hồi + ôn ngắt quãng, phân đoạn do người đọc điều khiển; cảnh báo tương tác có thể bị bỏ không dùng và không phải lúc nào cũng đáng công.
- **The Annotated Transformer** (Harvard NLP), https://github.com/harvardnlp/annotated-transformer — "code có chú giải": đoạn paper, ngay sau là code cài đúng đoạn đó, cả bài chạy được như notebook.
- **Jay Alammar, Illustrated Transformer** — mở dần từ hộp đen; giải thích self-attention hai lần (từng từ, rồi ma trận); kích thước đồ chơi (4 ô thay 512 chiều); **một ví dụ chạy suốt bài**.
- **CNN Explainer** (VIS'20, arXiv 2004.15004), **Transformer Explainer** (CHI'26, arXiv 2408.04619) — tổng quan + chi tiết, chuyển mượt từ cấu trúc tới phép tính, chạy hoàn toàn trong trình duyệt, người dùng nhập dữ liệu và chỉnh tham số; Transformer Explainer: N = 90, cải thiện hiểu biết có ý nghĩa. Cả hai làm tay cho đúng một kiến trúc: chi phí mà máy sinh tự động cần cắt bớt.

---

## 2. Khoa học học tập

| Phát hiện | Nguồn | Con số |
|---|---|---|
| Tự kiểm tra (practice testing) và ôn giãn cách: **hữu ích cao**. Tự giải thích, hỏi "vì sao", xen kẽ: **trung bình**. Tóm tắt, tô sáng, đọc lại, hình dung: **thấp** | Dunlosky et al. 2013 (bản tóm của tác giả), https://files.eric.ed.gov/fulltext/EJ1021069.pdf | Gợi nhớ hơn nhận diện; viết đáp án trước khi xem; luyện "tới khi nhớ đúng một lần", rồi đúng lại vào ngày khác. Tự giải thích phải *giải thích*, không diễn đạt lại. Hỏi "vì sao" cần kiến thức nền |
| Hiệu ứng kiểm tra: học lại thắng ngay sau đó, kiểm tra thắng về lâu dài; học lại làm **tự tin tăng dù nhớ kém hơn** | Roediger & Karpicke 2006, https://learninglab.psych.purdue.edu/downloads/2006/2006_Roediger_Karpicke_PsychSci.pdf | 5 phút: 81 % vs 75 % (học lại thắng); 2 ngày: 54 % vs 68 %; 1 tuần: 42 % vs 56 %. Kiểm tra lặp 61 % vs học lặp 40 % sau 1 tuần |
| Hỏi trước khi học (prequestion) giúp, kể cả khi trả lời sai, **nếu sau đó được xem đáp án**; lợi ích chủ yếu cho đúng nội dung được hỏi; trắc nghiệm có phương án nhiễu lấy từ chỗ khác trong bài thì lợi cả phần đó | Pan & Carpenter 2023, https://link.springer.com/content/pdf/10.1007/s10648-023-09814-5.pdf | Hỏi trước từng đoạn ("interpolated") hiệu quả; nhưng tự kiểm tra *sau* khi đọc cho hiệu ứng 1 tuần lớn hơn. Người học thường tin hỏi trước vô ích |
| Khó khăn đáng có: giãn cách, xen kẽ, kiểm tra thay vì trình bày, tự sinh thay vì được cho xem | Bjork & Bjork 2011, https://bjorklab.psych.ucla.edu/wp-content/uploads/sites/13/2016/04/EBjork_RBjork_2011.pdf | "Mỗi lần tra đáp án hay để người khác chỉ cho cái mình tự sinh ra được, bạn tự cướp đi một cơ hội học." Xen kẽ 63 % vs 20 % (Rohrer & Taylor), dù người học thấy học khối tốt hơn |
| Khoảng cách ôn tối ưu tùy thời gian muốn nhớ | Cepeda et al. 2008, http://www.yorku.ca/ncepeda/publications/CVRWP2008.pdf | ~20–40 % của khoảng nhớ 1 tuần, giảm còn ~5–10 % với khoảng nhớ 1 năm (> 1 350 người) |
| Tự giải thích | Chi 1989, 1994 (chương của Fonseca & Chi), https://education.asu.edu/sites/g/files/litvpz656/files/lcl/instruction_based_on_self_explanation.pdf | Được nhắc tự giải thích thắng đọc hai lần, d = 1,14. Cơ chế: lấp chỗ hổng, sửa mô hình trong đầu. Hình đơn giản gợi tự giải thích nhiều hơn chữ |
| ICAP: Tương tác > Kiến tạo > Chủ động > Thụ động; **bước nhảy lớn nhất là Chủ động → Kiến tạo** | Chi & Wylie 2014 (chương Chi & Boucher), https://www.unh.edu/teaching-learning-resource-hub/sites/default/files/media/2023-05/itow-applying-the-icap-framework-to-improve-classroom-learning-chi-boucher.pdf | **Chọn đáp án từ một danh sách là Chủ động**; giải thích, so sánh, dự đoán, thiết kế là Kiến tạo; Tương tác đòi cả hai bên cùng kiến tạo, luân phiên |
| Ví dụ mẫu mờ dần: ví dụ đầy đủ → thiếu dần → tự giải; **mờ từ bước cuối** tốt hơn từ bước đầu | Renkl & Atkinson 2003 | Mờ dần giúp chuyển giao gần; thêm câu nhắc tự giải thích giúp chuyển giao xa; nên thích ứng theo người học |
| Nguyên tắc đa phương tiện | Mayer 2008 | d trung vị: liền kề không gian (nhãn cạnh hình) 1,12 · phân đoạn do người học điều khiển 0,98 · mạch lạc (bỏ trang trí) 0,97 · **dạy trước thuật ngữ/ký hiệu (pretraining) 0,85** · báo hiệu 0,52 |
| Đoán trước khi xem | Brod 2021, https://www.pedocs.de/volltexte/2021/23704/pdf/EPR_2021_4_Brod_Generative_Learning_A.pdf | Bằng chứng thuận lợi với sinh viên đại học; cơ chế: gọi kiến thức cũ, tò mò, bất ngờ; phải xử lý phản hồi mới có lợi. Chưa có meta-analysis |
| Gia sư AI có cấu trúc | Kestin et al. 2025 (RCT, vật lý Harvard), https://www.nature.com/articles/s41598-025-97652-6 | Hơn học chủ động trên lớp 0,73–1,3 SD. "Prompt hệ thống không đủ để giữ cấu trúc" cho bài nhiều phần → nền tảng **ép trình tự từng bước**; chống bịa bằng cách cho sẵn lời giải từng bước trong prompt |
| Trợ giúp AI không rào chắn làm hại | Bastani et al. 2025 (PNAS) | GPT-4 tự do tăng điểm luyện tập nhưng **giảm** kỹ năng khi tự làm sau đó; gia sư chỉ gợi ý (không đưa đáp án) loại bỏ phần hại. Con số +48 %/−17 % [chưa kiểm] |
| Nhiều cách biểu diễn + quiz nhúng | Google "Learn Your Way" (arXiv 2509.13348), RCT N = 60 | Nhớ sau 3–5 ngày: 78 % vs 67 % |
| Feynman technique | https://fs.blog/feynman-technique/ | Lời khuyên thực hành (không phải của Feynman); hiệu quả đến qua tự giải thích và tự sinh |

---

## 3. Thiết kế câu hỏi và chấm bài

- **Bloom bản sửa đổi** (Krathwohl 2002), https://www.chemnet.edu.au/sites/default/files/files/Blooms_taxonomy_2002_Krathwohl.pdf — sáu quá trình (nhớ, hiểu, áp dụng, phân tích, đánh giá, sáng tạo) × bốn loại kiến thức (sự kiện, khái niệm, quy trình, siêu nhận thức). Không phải bậc thang cứng. Với một paper ML: nhớ dataset/metric · giải thích vì sao cần một lựa chọn thiết kế · chạy Eq. N trên đầu vào đồ chơi · chỉ ra ablation nào tách được thành phần X · phê bình Bảng K có đỡ được claim Y không · thiết kế thí nghiệm tách giả thuyết A và B.
- **Haladyna, Downing & Rodriguez 2002** (31 quy tắc viết câu trắc nghiệm), https://site.ufvjm.edu.br/fammuc/files/2016/05/item-writing-guidelines.pdf — một ý mỗi câu; ý quan trọng, không vụn vặt; dùng tình huống mới và diễn đạt lại để đo mức cao; ý chính nằm trong thân câu; thân câu khẳng định; **ba phương án là đủ**; đúng một đáp án; đổi vị trí đáp án đúng; phương án không chồng nhau, cùng loại, dài xấp xỉ nhau; tránh "tất cả các ý trên"; không để lộ đáp án; **phương án nhiễu phải hợp lý, lấy từ lỗi điển hình của người học**. Câu viết lỗi làm giảm điểm mà không phân loại tốt hơn; ngôn ngữ đơn giản giúp người đọc không phải bản ngữ (đúng với người đọc tiếng Việt đọc paper tiếng Anh).
- **Trắc nghiệm hai tầng** (Treagust), https://openjournals.library.sydney.edu.au/IISME/article/download/6375/7014 — tầng 1 chọn đáp án, tầng 2 chọn lý do (gồm lý do đúng và các hiểu sai thu được); **chỉ tính đúng khi đúng cả hai**. Tầng 2 mới đào sâu.
- **Chấm theo độ chắc chắn** (Gardner-Medwin), https://tmedwin.net/cbm/cbm.htm — mức 1: +1/0; mức 2: +2/−2; mức 3: +3/−6. Mức 3 chỉ đáng khi chắc > 80 %, mức 2 khi > ~67 %; không thể có lợi khi khai sai độ chắc. **Sai mà chắc = hiểu sai cần xử lý.**
- **Câu hỏi do LLM sinh**:
  - Doughty et al. 2024, https://arxiv.org/pdf/2312.03173 — 651 câu GPT-4 vs 449 câu người viết: rõ ràng ngang nhau, nhưng **4,9 % câu GPT-4 có nhiều đáp án đúng** (người: 1,1 %), 4,0 % có phương án nhiễu lộ đáp án (người: 0,9 %); câu nhiều đáp án đúng dồn ở mức Áp dụng và Sáng tạo.
  - Scaria et al. 2024, https://arxiv.org/pdf/2408.04394 — 78 % câu chất lượng cao nhưng **chỉ 65,56 % đúng mức Bloom yêu cầu**; prompt tốt nhất: chain-of-thought + mô tả kỹ năng + một câu ví dụ; prompt dài hơn thì kém đi; LLM chấm không khớp chuyên gia.
  - Moore et al. 2023, https://arxiv.org/abs/2307.08161 — với 19 lỗi viết câu, **bộ kiểm theo luật bắt 91 %** lỗi mà người chú thích thấy, GPT-4 bắt 79 %.
  - Phương án nhiễu do LLM sinh dùng được ngay ~53 % [chưa kiểm].
- **Chấm tự luận bằng LLM**:
  - Zheng et al. 2023, https://arxiv.org/pdf/2306.05685 — thiên vị vị trí, độ dài, tự đề cao, yếu ở toán/suy luận. Cách bù: vài ví dụ mẫu (độ nhất quán 65 % → 77,5 %), cho LLM tự giải trước, **chấm có đáp án tham chiếu** (tỉ lệ hỏng ở toán 70 % → 15 %).
  - Jiang & Bosch 2024 — GPT-4 chấm câu trả lời ngắn: QWK 0,677; chất lượng rubric ảnh hưởng kết quả.
  - Caraeni et al. 2024, https://arxiv.org/abs/2411.05231 — rubric làm tăng độ khớp với người chấm, nhưng vẫn chưa đủ chính xác để dùng thật cho bài thi.

---

## 4. Công cụ và nguyên mẫu đã có

| Công cụ | Có gì | Thiếu gì cho việc hiểu sâu |
|---|---|---|
| alphaXiv | chat trích dẫn được từng đoạn, "blog" tự sinh có hình, bình luận theo dòng, so với paper khác, MCP server | không kiểm người đọc hiểu gì; blog "nghe đúng nhưng hơi lệch" ở phương pháp lạ và toán; chat có thể bỏ qua đúng bước lập luận quan trọng |
| NotebookLM | chat có trích dẫn, audio/video overview, mind map, study guide, flashcard, quiz, "Learning Guide" kiểu Socratic | không neo vào công thức/hình; quiz không thích ứng theo hiểu sai; người dùng phàn nàn hình trong PDF bị bỏ qua |
| ChatGPT Study Mode, Gemini Guided Learning, Claude learning mode | gia sư Socratic, quiz, kiểm mức độ | chỉ là prompt (OpenAI thừa nhận hành vi không nhất quán); không gắn với cấu trúc paper |
| SciSpace, Explainpaper, ChatPDF | tô chữ → giải thích (cả công thức, bảng), chat có trích dẫn | chỉ giải thích; không luyện tập, không kiểm hiểu |
| Elicit, Consensus, Connected Papers, ResearchRabbit, Litmaps | tổng hợp nhiều paper, đồ thị trích dẫn | không giúp gì bên trong một paper |
| Hugging Face Papers | bàn luận, link model/dataset/code; `/papers/<id>.md` trả toàn văn markdown từ HTML arXiv; nơi kế thừa Papers with Code | lớp khám phá, không phải trình đọc |
| Ai2 Semantic Reader / Asta | tô sáng để lướt (Mục tiêu/Phương pháp/Kết quả), thẻ trích dẫn có TLDR, CiteSee | còn "beta", chỉ arXiv |

**Nguyên mẫu nghiên cứu (HCI)** — Semantic Reader Project (Lo et al., CACM 2024, arXiv 2303.14334; mười nguyên mẫu, > 300 người tham gia):

- **ScholarPhi** (CHI'21): định nghĩa thuật ngữ và **ký hiệu theo vị trí** khi rê chuột, sơ đồ công thức gắn nhãn từng ký hiệu, bảng thuật ngữ tự động. "Mọi người đọc nói sẽ dùng tooltip định nghĩa và sơ đồ công thức thường xuyên hoặc luôn luôn."
- **Paper Plain**: tóm ý từng mục, câu hỏi then chốt dẫn tới đoạn trả lời; dễ đọc hơn "mà không giảm mức hiểu".
- **Scim** (IUI'23): tô sáng theo vai trò (mục tiêu, điểm mới, phương pháp, kết quả), phân bố đều, mật độ chỉnh được; quá ít thì vô dụng, quá nhiều làm chậm.
- **CiteSee/CiteRead, Threddy/Relatedly, Papeo**: cá nhân hóa trích dẫn, gom related work, gắn video với đoạn paper.
- Bài học của dự án: tăng cường PDF có sẵn (tác giả sẽ không tự làm bản tương tác); đặt trợ giúp đúng chỗ người đọc đang nhìn; "sai sót nhỏ của mô hình cũng gây hại"; giúp người đọc quyết định **phần nào đáng đọc kỹ**.

**LLM thời gần đây**:

- **ReaderQuizzer** (CSCW'23) [chưa kiểm bản gốc]: câu hỏi hiểu và phân tích do LLM sinh, đặt cạnh đoạn liên quan; N = 16, tăng tương tác và ghi nhớ; người dùng thích được tự mở đáp án.
- **Thought exchanges tại chỗ cho đọc phê phán** (arXiv 2510.15234): agent "đồng nghiệp" trả lời ghi chú của người đọc; N = 46 trong hai tuần, **tư duy phản biện tăng có ý nghĩa** so với không có agent; nhiều agent khiến người đọc cân nhắc các góc nhìn.
- **PaperTrail** (CHI'26) [chưa kiểm bản gốc]: tách câu trả lời của LLM và paper thành claim/chứng cứ, hiện claim nào có chứng cứ; giảm lòng tin nhưng người dùng vẫn dựa vào LLM — chỉ hiện nguồn thôi chưa đổi được hành vi.
- **Explorable Proofs** (UIST'26) [chưa kiểm bản gốc]: chứng minh → Lean nối từng bước; trả lời câu hỏi hiểu đúng và chi tiết hơn so với "chứng minh + chatbot". Giải thích chạy được thắng chat.
- **"Explain Like I'm 5 or Whatever I Choose"** (arXiv 2606.06788) [chưa kiểm bản gốc]: LLM đổi độ phức tạp đúng hướng yêu cầu tối đa 33–46 % số lần → **thanh trượt "người mới ↔ chuyên gia" chỉ bằng prompt không đáng tin**.
- **Sinh định dạng khác từ paper**: Paper2Code/PaperCoder (arXiv 2504.17192: lập kế hoạch → phân tích → code; lỗi chủ yếu ở chi tiết dữ liệu paper không nói rõ), Paper2Agent (arXiv 2509.06917: paper + code → MCP server), PaperVoyager (arXiv 2603.22999: paper → hệ thống web tương tác chạy được), Paper2Web/Paper2Poster/Paper2Video dùng **PaperQuiz** (người đọc sản phẩm sinh ra có trả lời được quiz về paper không) để đánh giá.

**Khoảng trống**: (1) chỉ kiểm hiểu ở mức nhớ; không công cụ nào sinh câu hỏi neo vào đúng công thức/hình/claim và chấm tự luận theo chứng cứ trong paper; (2) không sản phẩm nào có hiểu biết ở mức công thức kiểu ScholarPhi; (3) không có cầu từ paper sang trực giác chạy được (Annotated Transformer, Transformer Explainer đều làm tay); (4) độ trung thực vô hình; (5) gia sư là prompt, không phải quy trình; (6) không có bản đồ kiến thức nền *cho riêng người đọc*; (7) điều chỉnh mức độ bằng prompt không đáng tin; (8) không trình đọc nào có ôn ngắt quãng.

---

## 5. Khối kỹ thuật

- **HTML của arXiv** (LaTeXML, từ 12/2023), https://info.arxiv.org/about/accessible_HTML.html — ~97 % bài nộp có HTML, ~75 % chuyển không lỗi (mục tiêu 90 %; lỗi chủ yếu do gói LaTeX không hỗ trợ). **ar5iv** cho paper cũ (theo đợt, một phiên bản). Đã thử tay trên LoRA (2106.09685v2): id `S1`, `S4.SS1`, `S1.p3`, `S2.E1`, `S1.F1`, `S3.T1`; TeX gốc ở `alttext` của `<math>`.
- **E-print**: `/src/<id>` luôn là tar.gz, `/e-print/<id>` có thể là một file `.tex` gzip; một số paper chỉ có PDF. **Điều khoản** (https://info.arxiv.org/help/api/tou.html): API tối đa 1 yêu cầu / 3 giây, một kết nối; dùng cá nhân/nghiên cứu được; không phục vụ lại PDF/nguồn khi giấy phép không cho; metadata CC0.
- **PDF → chữ có cấu trúc** (đều là Python): MinerU (công thức tốt nhất, giấy phép có điều kiện), Marker (code Apache-2.0, trọng số OpenRAIL-M), Docling (MIT), GROBID (Apache-2.0, giỏi tham khảo và vị trí, cần Docker trên Windows), Nougat (trọng số phi thương mại, gần như bỏ), PyMuPDF (AGPL). pdf.js chỉ cho chữ có vị trí, công thức bị vỡ: dùng để neo, không dùng để hiểu.
- **KaTeX**: `trust: false`, `maxExpand`, `maxSize` hữu hạn với đầu vào không tin cậy; option `macros` nhận `\newcommand` của paper (coi chừng macro toàn cục rò giữa các lần gọi). MathJax 4 làm dự phòng.
- **pdf.js trong webview**: `pdfjs-dist` ≥ 4.2.67 với `isEvalSupported: false` (CVE-2024-4367: JavaScript tùy ý qua font).
- **Neo chú thích**: W3C `TextQuoteSelector` (đúng chữ + trước/sau) cùng `TextPositionSelector`, trên chữ đã rút của PDF, so khớp mờ khi trượt; lưu thêm số trang (cách của Hypothesis).
- **Semantic Scholar Graph API**: tra theo `ARXIV:<id>`, có `tldr`; `/citations`, `/references` có `contexts`, `intents` (background/method/result), `isInfluential`; 1 yêu cầu/giây khi có key. **Papers with Code** đã đóng (7/2025), chuyển về HF `/papers/trending`; link code qua HF API (`githubRepo`) hoặc tìm `github.com` trong LaTeX.
- **Sandbox cho HTML/JS do AI sinh trong VS Code**: hướng dẫn của VS Code (https://code.visualstudio.com/api/extension-guides/webview) không nói về iframe lồng. Trong Chromium, `srcdoc` **thừa kế CSP của trang cha**; `allow-scripts` cùng `allow-same-origin` thì thoát được sandbox. Mẫu được khuyên: `WebviewPanel` riêng (origin và CSP riêng), hoặc `iframe sandbox="allow-scripts"` không same-origin; `connect-src 'none'`; thư viện cục bộ; `postMessage` theo schema cố định. Claude Artifacts: iframe sandbox, origin riêng, CSP chặt.
