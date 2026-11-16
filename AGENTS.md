# agent-in-notebook

Chỉ dẫn cho mọi coding agent làm việc trong repo này (Claude Code, Codex, …). Giữ file này ngắn: nó được nạp vào mọi phiên làm việc. Chi tiết nằm ở các tài liệu được trỏ tới, chỉ đọc khi việc cần.

- Kiến trúc và cách các gói nối với nhau: `docs/architecture.md`.
- Kiểm tra trước khi báo xong: `pnpm typecheck`, `pnpm test`.

## Sửa phần lõi hoặc cập nhật OpenResearch

Mentor được đan vào các file của lõi (`chat.ts`, `server.ts`, `notebook/tools.ts`, `protocol`, adapter trong `extension/src/page/`). Khi sửa các file đó, đổi tên tool, đổi câu báo lỗi, hay nâng submodule `openresearch`:

- Chạy `pnpm --filter @ainb/bridge test mentor` trước khi báo xong.
- `mentor-contract.test.ts` trượt nghĩa là một thứ Mentor dựa vào đã đổi: sửa phía Mentor theo lời nhắn của test, không xóa hay nới test.
- Danh sách chỗ nối: `docs/architecture.md`, mục "Mentor bám vào phần còn lại ở đâu".

## Thêm hoặc sửa nội dung Mentor

Khi được nhờ thêm chủ đề, bài tập, câu hỏi hay hint cho Mentor (ML tutor), **đọc `packages/bridge/mentor-catalog/PROTOCOL.md` trước và làm đúng theo nó**. Tóm tắt:

- Nội dung thêm sau luôn nằm trong một gói `packages/bridge/mentor-catalog/packs/<id>/`. Không sửa `map.json`, không thêm vào `exercises/` của bộ gốc.
- Kiểm bằng `pnpm ainb mentor check <pack-id hoặc id bài>`; xong thì `pnpm ainb mentor reload`.
- Máy này không có PyTorch: bài PyTorch cần kiểm trên Kaggle (`pnpm ainb mentor verify <id…>`) trước khi đến tay người học.
