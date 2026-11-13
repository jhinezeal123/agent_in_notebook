# Kiến trúc

Ba package TypeScript trong một pnpm workspace:

| Package | Chạy ở đâu | Vai trò |
|---|---|---|
| `protocol` | cả hai phía | Kiểu dữ liệu notebook, giao thức WS, `RpcPeer`, policy của mode (`decide`), diff theo dòng, chuẩn hóa output ipynb |
| `bridge` | Node, trên máy user | Server WS/HTTP, quản lý chat, chạy agent qua ACP, tool notebook (MCP) |
| `extension` | Chrome MV3 | Adapter notebook trong trang, content script, service worker, side panel (Preact) |

## Luồng một tool call

```
agent ──MCP stdio──► `ainb mcp` (relay không trạng thái)
                       │ HTTP POST /mcp/call  (Bearer = token của chat)
                       ▼
                    bridge: Chat.runTool → callTool
                       │ 1. kiểm tra mode (protocol/modes.ts: decide)
                       │ 2. gửi NotebookOp
                       ▼  WS "notebook.op" {tabId, op}
                    service worker ──chrome.tabs.sendMessage(frameId)──► content script
                                                                          │ window.postMessage
                                                                          ▼
                                                     page script (MAIN world): OpRunner → adapter
```

- **Vì sao relay stdio:** stdio là transport MCP duy nhất mà mọi agent ACP bắt buộc phải hỗ trợ. Relay không giữ trạng thái gì; bridge nhận ra chat nhờ token.
- **Vì sao kiểm tra mode trên từng lời gọi:** danh sách tool không đổi, nên agent không phải nạp lại. Đổi mode có hiệu lực từ lời gọi kế tiếp, và lời từ chối kèm lý do để agent nói lại cho user.
- **Review không chặn page:** op trả về `reviewId` ngay. Bridge chờ event `review_closed` trong khoảng `toolWaitMs` của agent. Quá hạn thì trả "đang chờ duyệt" và agent gọi `await_review`. Nhờ vậy Codex với giới hạn tool 60 giây vẫn dùng được.

## Agent (học từ openresearch_custom)

orx có lớp `Harness` riêng cho từng agent (khoảng 30k dòng Rust) vì mỗi agent nói một giao thức khác nhau. Ở đây cả bốn agent đều nói ACP: Claude Code và Codex qua adapter npm chính thức, Gemini qua `--acp`, OpenCode qua `opencode acp`. Vì vậy chỉ cần **một** client ACP (`bridge/src/agents/acp-agent.ts`) và **một registry** (`registry.ts`), trong đó mỗi agent chỉ là "chạy thế nào và nhận biết có hay không". Agent ACP khác thêm vào bằng `agents.json`.

Những gì giữ lại từ thiết kế orx:

- Transcript của bridge là bản ghi gốc; session riêng của agent chỉ là ngữ cảnh. Message được phát nguyên cả bản (gom mỗi 80ms), side panel thay thế thay vì ghép delta.
- Playbook đi theo turn đầu của session. Một khối `<notebook-context>` ngắn (mode, cell đích, outline) đi theo mọi turn, nên đổi mode không cần restart agent.
- Khi đổi agent hoặc agent crash: agent mới nhận một bản tóm tắt có giới hạn (`instructions.ts: recap`).
- Yêu cầu xin quyền không bao giờ tự cho phép: Stop, đóng chat hay agent chết đều trả `cancelled`.
- Tin nhắn gửi lúc agent đang bận được xếp hàng; Stop xóa hàng đợi.

## Adapter notebook

**Colab** (`extension/src/page/colab.ts`). `colab.global.notebook` cung cấp cell (`getId/getType/getText/setText`, `getModel().toJson()` cho output) và `colabMcpToolsService.tools`, bộ tool agent Colab dùng cho Gemini, tìm theo `toolName` vì tên này không bị minify. Review dùng `cell.showInlineDiffTo(text)`: hàm này trả Promise\<boolean\> theo lựa chọn của user, và `getInlineDiff().accept()/reject()` để side panel quyết thay.

**Kaggle / Jupyter** (`jupyter.ts`). Editor của Kaggle là Jupyter Notebook 7 (JupyterLab 4) trong iframe, config có `exposeAppInBrowser: true`, nên có `window.jupyterapp`. Adapter sửa cell qua `sharedModel` (`setSource/insertCell/deleteCell/moveCell`) và chạy cell bằng lệnh `notebook:run-cell`, lệnh này resolve khi cell chạy xong. Trạng thái đang chạy đọc từ prompt `[*]` vì bản 4.0 chưa có `executionState`. Review dùng thẻ diff riêng (`review-widget.ts`, shadow DOM).

Thêm platform mới chỉ cần implement `NotebookAdapter` (`page/adapter.ts`) và đăng ký trong `page/main.ts`.

## Chuẩn bị agent và quản lý launch command

Side panel mở session ACP ngay khi notebook và agent đã được chọn. `session/new` cung cấp model/effort qua config options trước khi gửi prompt; thay đổi option được áp dụng xong trước khi bật Send. Mỗi tab vẫn dùng một session chat, kể cả lúc transcript còn trống.

`agents.save`, `agents.remove` và `agents.test` chạy qua liên kết extension đã pairing. Launch command được tách thành executable và argv, không chạy qua shell. Agent tùy chỉnh được lưu nguyên các trường cấu hình đang có trong `agents.json`; các lần lưu cập nhật file bằng rename và phát `agents.changed` để side panel cập nhật ngay. Test connection tạo session tạm, từ chối yêu cầu quyền, đọc options rồi dừng agent; không gửi prompt. Sửa/xóa agent đang chạy bị từ chối; session idle được đóng và transcript được giữ để mở lại bằng cấu hình mới.

## Chat theo notebook

Mỗi notebook có một khóa ổn định (`protocol/identity.ts: notebookKey`), do service worker tính từ URL cấp cao nhất của tab (iframe Kaggle không biết mình là notebook nào) và, với Jupyter, đường dẫn tài liệu. Side panel gửi khóa này trong `chat.open`; bridge giữ chat sống theo tab nhưng lưu transcript theo khóa (`bridge/src/store.ts`, ghi gộp mỗi giây và khi đóng chat). `chat.open` khôi phục transcript đã lưu và agent nhận tóm tắt như sau khi crash; những gì còn đang chờ trong bản lưu (prompt, review, tool) được chốt thành cancelled/discarded/failed. `notebook.attached` mang khóa khác khóa của chat thì chat bị lưu và đóng, để agent cũ không sửa nhầm notebook mới. `notebook.detached` chốt các review đang chờ thành `discarded`, vì trang đã mất chúng.

Kết quả đọc notebook (`read_cells`, `list_cells`, `wait_for_cells`) có ngân sách tổng khoảng 60k ký tự; phần còn lại được nêu tên kèm `start_index` để agent đọc tiếp.

## Bảo mật

Xem README. Hai điểm thiết kế đáng nhớ:

- WebSocket không bị CORS chặn, nên bridge kiểm tra cả Origin lẫn pairing token.
- Content script chỉ chuyển lên dữ liệu notebook; trang web không thể khiến bridge chạy agent.
