# Thiết kế đợt 2: protocol & đồng bộ theo phần thay đổi

Trạng thái: đặc tả cho worker triển khai (đã chốt bởi lead sau khi đọc `protocol/src/notebook.ts`, `adapter.ts`, `run-watcher.ts`, `outputs.ts` và báo cáo phân tích). Mục tiêu: các mục A2.1–A2.5, A4.1–A4.4 (phần protocol), A6.2 (CAS), A6.3 (minimal diff) trong `de-xuat-tinh-nang-toi-uu.md`. Nguyên tắc: mọi thay đổi tập trung ở `OpRunner`/protocol khi có thể (adapter chỉ bổ sung thứ chỉ nó biết); tương thích ngược bằng trường tùy chọn; bump `WIRE_VERSION` 5→6 một lần cho cả đợt.

## 1. `get_cells` thêm cờ `sourceHash` (A2.2)

- `NotebookOp.get_cells` thêm `sourceHash?: boolean`. `CellInfo` thêm `sourceHash?: string`.
- Ngữ nghĩa (đối xứng `outputsHash` sẵn có, adapter.ts:150-166): khi `sourceHash:true`, mỗi cell trả `sourceHash = textHash(source)` (FNV-1a, `text.ts`) và `source = ""` (cắt tại trang, source đầy đủ không qua wire), kèm `lineCount` như summary. Kết hợp được với `outputsHash:true` (mirror dùng cả hai: digest source + fingerprint outputs, không payload).
- `summary` và `sourceHash` cùng bật: sourceHash thắng (source rỗng + hash + lineCount).
- Stale/pendingReview vẫn gắn như hiện tại (stale cần source đầy đủ để so hash — khi source bị cắt, dùng `watcher.isStale` với hash? `isStale(cellId, source)` so textHash(source); gọi `isStale(c.id, "")` sẽ sai. Sửa: thêm `watcher.isStaleHash(cellId, hash)` hoặc cho isStale nhận hash đã tính; OpRunner truyền `sourceHash` khi có, `textHash(source)` khi không).

## 2. `imageBudget` tại nguồn + op `get_output_image` (A2.3)

- `get_cells` và `run_cells` thêm `maxImages?: number`, `maxImageBytes?: number` (đếm theo độ dài base64).
- OpRunner lọc ảnh TRƯỚC khi trả kết quả (một ngân sách chung cho cả lần gọi): giữ tối đa maxImages ảnh đầu tiên (theo thứ tự cell/output) còn trong maxImageBytes; ảnh bị lọc: bỏ trường `image`, thêm mime vào `mimes` (cơ chế sẵn có của CellOutput) để agent biết có ảnh không gửi.
- Op mới `get_output_image { cellId, outputIndex }` → `{ image?: OutputImage }`: đọc `adapter.getCells({cellIds:[id], includeOutputs:true})`, trả ảnh của output thứ outputIndex (không budget). Mirror/read_output dùng khi cần ảnh thật.
- Bridge (đợt 2b-bridge1) truyền budget của Attachments (4 ảnh / 3MB) vào run_cells/get_cells; Attachments giữ làm lưới an toàn. Mirror KHÔNG truyền budget (cần ảnh đầy đủ).

## 3. `update_cell` compare-and-set (A6.2)

- Thêm `expectedSource?: string`. Sau khi đọc cell hiện tại (OpRunner đã đọc sẵn, adapter.ts:170): nếu `expectedSource !== undefined && cell.source !== expectedSource` → trả `{ applied:false, conflict:true }`, KHÔNG áp, KHÔNG journal, KHÔNG review.
- `NotebookOpResults.update_cell` thêm `conflict?: boolean`.
- Không có expectedSource → hành vi cũ y nguyên (kể cả `{applied:false}` khi source đã bằng).
- Mirror (2b-vscode) gửi expectedSource = bản known mà user đã sửa từ đó; nhận conflict → re-pull cell + báo user, không đè.

## 4. `execute_wait` delta (A2.4)

- `OutputCollector` thêm `gen: number` (bắt đầu 0), tăng khi: `clear()` (cả wait=true lúc thực sự xóa), và khi stream bị cắt giữa chừng do STREAM_MAX (text không còn append-only).
- `execute_wait` thêm `since?: { gen:number, n:number, chars:number }` — client đã có n outputs, trong đó output thứ n-1 (nếu là stream) đã nhận chars ký tự.
- Khi còn chạy (`status:"running"`):
  - `since` vắng mặt hoặc `gen` lệch → trả full như cũ + `gen` hiện tại: `{status:"running", outputs, execId, gen}`.
  - `gen` khớp → trả `{status:"running", execId, gen, delta:{ n, chars, tail, rest }}` với `tail = outputs[n-1].text.slice(chars)` (chỉ khi output đó là stream; nếu không phải stream thì tail="" và rest bắt đầu từ n-1), `rest = outputs.slice(n)`. Client nối tail vào stream cuối rồi push rest; trạng thái mới: n' = n + rest.length; chars' = chars + tail.length nếu rest rỗng, ngược lại bằng độ dài text của rest cuối nếu nó là stream, hoặc 0.
- Kết quả cuối (ok/error) LUÔN full outputs + gen (agent đọc kết quả đầy đủ; delta chỉ cho nhịp chờ).
- `ExecResult` thêm `gen?: number`, `delta?: {n:number, chars:number, tail:string, rest:CellOutput[]}`.
- Client (bridge `wait_for_code` — 2b-bridge1; mirror showLive — 2b-vscode) giữ trạng thái per-execId và merge; không gửi since → hành vi cũ.

## 5. `runToken` + reprime (A4.4)

- `CellRunState` thêm `runToken?: string`. Adapter Jupyter sinh token per-cell: generation tăng mỗi khi thấy future MỚI của cell (dựa `seenFutures` sẵn có, jupyter.ts:107-126); token = generation dạng chuỗi. Colab/VS Code không có → undefined (hành vi cũ).
- `RunWatcher`:
  - finished thêm điều kiện: `!s.running && s.runToken && prev.runToken && s.runToken !== prev.runToken` (run mới kể cả executionCount trùng sau restart).
  - cell mới xuất hiện (chưa có prev) sau prime: nếu `s.runToken && !s.running && s.executionCount != null` → coi như fast run đã xong, emit (phân biệt với paste/undo cell cũ: chỉ token do trang chứng kiến future mới có).
  - thêm `reprime()`: xóa known/ranHash, prime lại từ states hiện tại (không emit). OpRunner gọi khi kernel chuyển từ disconnected/unknown sang idle/busy (checkKernel).
- Thu hẹp 2 giới hạn đã biết của docs; phần Colab không có future vẫn thừa nhận rủi ro còn lại.

## 6. Op batch `apply_cells` (A2.5)

- Op mới `{ op:"apply_cells", steps: NotebookOp[] }` — steps chỉ gồm update_cell/insert_cell/delete_cell/move_cell (runtime check, sai → OpError).
- OpRunner chạy tuần tự từng step bằng chính `this.run(step)` (giữ nguyên review/journal/change_applied thứ tự), trả `{ results: unknown[] }` tương ứng từng step. Một round-trip wire thay vì N.
- Bridge `applyCells` (nbfile.ts) dùng batch khi page cùng WIRE_VERSION (hello đã chặn lệch version nên luôn dùng được); giữ đường op lẻ làm fallback code path nếu cần test.

## 7. Pulse + dispose (A4.2 phần protocol)

- Mỗi nhịp timer: gọi `adapter.info()` MỘT lần, dùng chung cho checkKernel (truyền info vào) — không đổi hành vi emit.
- `NotebookAdapter` thêm `dispose?(): void`; `OpRunner.dispose()` gọi nó (colab clears selection interval — 2b-extension).
- `adapter.onSelectionChange` callback hiện gọi `adapter.info()` riêng — giữ (sự kiện thật, không phải poll).

## 8. Fingerprint proxy (A2.2 phần CPU)

- `OutputFingerprints.read(id, outputs, stable?: boolean)`: khi `stable` (cell không running) và proxy rẻ không đổi (số outputs, tổng độ dài text, tổng độ dài base64 ảnh, kind cuối) → trả hash cache, KHÔNG stringify lại. Proxy lệch → tính lại như cũ. OpRunner truyền `stable = !c.running`.
- Lý do an toàn: outputs chỉ đổi khi run (executionCount/running đổi → stable=false) hoặc clear (đổi count/length). Test: đổi output cùng độ dài khi cell idle vẫn phải phát hiện nếu proxy bao gồm nội dung? — KHÔNG: chấp nhận rủi ro lý thuyết này chỉ khi idle và mọi proxy khớp; ghi comment giải thích. (Nếu thấy không chắc, bỏ proxy — wire saving vẫn còn nhờ sourceHash.)

## 9. `wire.ts` + types cho đợt 3 (làm trước phần type)

- `WIRE_VERSION = 6`. Cập nhật `docs/architecture.md` dòng "Giao thức: WIRE_VERSION = 5" → 6 và đoạn nâng cấp README (thêm ghi chú 5→6: reload extension + tab + bridge).
- Bỏ `"session"` khỏi `ChatCard.kind` (không nơi nào tạo/đọc — đã grep).
- `ChatMessage.queued?: boolean` — bridge đánh dấu tin user đang xếp hàng, xóa khi lượt bắt đầu (2b-bridge2); UI dùng thay suy luận vị trí.
- `ReviewInfo` thêm `index?: number`, `label?: string` — OpRunner.open() đã đọc index (adapter.ts:288): điền index tại đó; label = firstLine(after || before, 60) (helper firstLine sẵn có).
- `BridgeMethods` thêm `"chat.changes": { params:{chatId:string, messageId:string}, result:{changes:AppliedChange[]} }` (handler ở 2b-bridge2; journal đã có sẵn `chat.journalEntries()`).
- KHÔNG thêm mentor.status đợt này (đợt 4).

## 10. Kiểm tra bắt buộc cho worker 2a

- `pnpm --filter @ainb/protocol test` + `pnpm --filter @ainb/extension test` (op-runner/jupyter-review tests sống ở extension) + targeted bridge `exec vitest run test/nbfile.test.ts test/chat.test.ts test/context.test.ts test/store.test.ts` (build dist trước nếu cần) + `pnpm typecheck` toàn repo.
- Test mới cho từng cơ chế: sourceHash cắt source + hash đúng; imageBudget lọc + mimes + get_output_image; CAS conflict không journal; delta gen/tail/rest + clear/truncate invalidate; runToken fast-run sau restart + reprime; apply_cells thứ tự journal; proxy fingerprint.
- KHÔNG đổi wording lỗi lõi (KERNEL_BUSY, OpError messages hiện có — mentor contract ghim câu "kernel is busy").
- KHÔNG đụng packages/bridge/src, packages/ui, packages/vscode, packages/extension/src/page (consumer làm đợt 2b) — chỉ protocol + tests + 2 dòng docs nêu trên.
