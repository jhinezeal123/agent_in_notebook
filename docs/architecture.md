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

## Ghép nối qua native messaging

`ainb install` (`bridge/src/native-host.ts`) viết một launcher (`.cmd` trên Windows, `.sh` trên macOS/Linux) gọi đúng bản Node và `cli.js native-host`, rồi đăng ký manifest `com.agent_in_notebook.bridge` cho từng trình duyệt: khóa registry `HKCU\…\NativeMessagingHosts` trên Windows, thư mục `NativeMessagingHosts` trong thư mục dữ liệu của trình duyệt trên macOS/Linux. Manifest chỉ cho phép extension có ID cố định (`EXTENSION_ID`, suy ra từ `key` trong manifest), cộng thêm các ID truyền qua `--extension-id`. Trên macOS/Linux, launcher giữ PATH lúc cài, vì trình duyệt mở từ giao diện đồ họa có PATH tối thiểu và sẽ không tìm thấy agent.

Service worker gọi `sendNativeMessage({type: "connect"})` trước khi mở WebSocket, nhưng chỉ khi có side panel đang mở (mở panel là user muốn dùng; trình duyệt khởi động thì không) và config không phải `manual`. Host đọc `config.json`, kiểm tra `/health`, nếu bridge chưa chạy thì khởi động `serve --log bridge.log` và chờ tối đa 15 giây, rồi trả port và token. Trên Windows bridge được khởi động qua `Start-Process`, vì Node cho tiến trình con thừa kế mọi handle inheritable của cha, kể cả pipe của trình duyệt, và bridge sẽ giữ chúng suốt đời mình. Host được bundle thành chunk riêng (esbuild `splitting`), nên không phải nạp SDK MCP/ACP, vốn mất vài giây.

Khi tắt có chủ đích (Ctrl+C, `ainb stop` → `POST /shutdown`), bridge đóng WebSocket với mã 4001; extension khi đó không tự kết nối lại hay bật lại bridge. Token bị từ chối thì extension hỏi lại host một lần, phòng trường hợp token đã bị reset. Token nhập tay (`config.set`) được đánh dấu `manual` để host không ghi đè, dùng cho bridge chạy trong WSL hoặc trên port khác.

## Chat theo notebook

Mỗi notebook có một khóa ổn định (`protocol/identity.ts: notebookKey`), do service worker tính từ URL cấp cao nhất của tab (iframe Kaggle không biết mình là notebook nào) và, với Jupyter, đường dẫn tài liệu. Side panel gửi khóa này trong `chat.open`; bridge giữ chat sống theo tab nhưng lưu transcript theo khóa (`bridge/src/store.ts`, ghi gộp mỗi giây và khi đóng chat). `chat.open` khôi phục transcript đã lưu và agent nhận tóm tắt như sau khi crash; những gì còn đang chờ trong bản lưu (prompt, review, tool) được chốt thành cancelled/discarded/failed. `notebook.attached` mang khóa khác khóa của chat thì chat bị lưu và đóng, để agent cũ không sửa nhầm notebook mới. `notebook.detached` chốt các review đang chờ thành `discarded`, vì trang đã mất chúng.

Kết quả đọc notebook (`read_cells`, `list_cells`, `wait_for_cells`) có ngân sách tổng khoảng 60k ký tự; phần còn lại được nêu tên kèm `start_index` để agent đọc tiếp (xem thêm mục Ngữ cảnh của agent).

## Hoàn tác

Trang notebook là nơi duy nhất biết chính xác một thay đổi đã áp dụng ra sao, nên `OpRunner` (`extension/src/page/adapter.ts`) phát `change_applied` (`AppliedChange`: loại, cell, vị trí trước đó, nội dung trước/sau) cho mỗi thay đổi thật sự xảy ra: thao tác trực tiếp, hoặc review được chấp nhận (phát trước `review_closed`, kèm `reviewId`). Thao tác có `byUser` (hoàn tác, "Insert as cell") không được ghi.

Bridge (`Chat`) gắn thay đổi vào tin nhắn agent của lượt đó; review chấp nhận muộn đi theo tin nhắn chứa review. Nội dung đầy đủ nằm trong `journal` của chat (lưu cùng transcript ở `store.ts`); tin nhắn chỉ mang `changes: { count, undone }` để không phát lại nội dung lớn mỗi lần stream. `chat.undo` chạy ngược từng thay đổi: chỉ đụng vào cell còn đúng nội dung `after`, chèn lại cell đã xóa ở vị trí cũ (cell mới có id mới, các thay đổi cũ hơn trên cell đó đi theo id mới), và ghi một `<undo-note>` vào prompt kế tiếp cho agent.

## Ngữ cảnh của agent

Mọi thứ tool trả về nằm lại trong context của agent cho tới hết session, nên bridge rút gọn trước khi gửi:

- **Output** (`protocol/outputs.ts: outputsToText`): stream liền nhau của cùng một luồng được nối lại rồi áp ký tự carriage return như terminal (thanh tiến trình chỉ còn trạng thái cuối), dòng lặp liên tiếp gộp thành một dòng đếm (`squeezeRepeats`). Nếu vượt giới hạn (6.000 ký tự mỗi cell), lỗi được giữ tối đa một nửa chỗ, phần còn lại cho log; cả hai cắt theo dòng (`capLines`), giữ đầu và phần cuối dài hơn. Dòng tên lỗi và frame đầu (code của user) vì vậy không bị log đẩy mất.
- **Ngân sách**: một lần đọc tối đa ~60k ký tự (`READ_BUDGET`); một lần chạy ~30k (`RUN_BUDGET`): cell lỗi giữ đủ 6.000, các cell khác chia phần còn lại (tối thiểu 1.200), quá ngân sách thì chỉ báo trạng thái.
- **Phần bị cắt** được đánh dấu kèm gợi ý `read_output`: tool này lấy toàn bộ output của một cell trong trang và trả về theo trang (`start_line`, `line_count`) hoặc theo regex có ngữ cảnh.
- **Data URI** trong source (ảnh dán vào markdown) thành nhãn `[[ainb:data-N …]]` (`hideDataUris`). `edit_cell` so khớp trên văn bản agent đã thấy, và `update_cell`/`edit_cell` đặt lại payload theo nhãn (`restoreDataUris`) trước khi ghi.
- **Outline mỗi lượt** đọc `get_cells` với `summary: true`: trang chỉ gửi dòng đầu và số dòng của mỗi cell. Nếu outline giống lượt trước (cùng session), `<notebook-context>` chỉ ghi "unchanged".
- **Usage**: `usage_update` của ACP được lưu trong chat (`ChatSnapshot.usage`) và phát qua `chat.usage`; side panel hiện mức đầy context.

Tool call song song: agent có thể gọi nhiều tool cùng lúc. `ToolContext.exclusive` xếp hàng theo hai khóa của chat: `edit` (đọc cell, tính nội dung mới, ghi, không xen kẽ, nên hai `edit_cell` trên một cell không ghi đè nhau) và `run` (Jupyter chạy cell qua "active cell"). Chờ review nằm ngoài khóa.

## Stream và lưu transcript

Bridge không gửi lại nguyên tin nhắn mỗi 80ms mà gửi `chat.patch` (`MessagePatch`): text/thought tăng bằng `{i, at, append}`, part khác được thay cả khi JSON của nó đổi. `at` neo vị trí nối nên áp một patch hai lần không nhân đôi text (snapshot có thể đã chứa phần đó). `applyMessagePatch` trả `null` khi patch không khớp (mất sự kiện) và side panel tải lại chat bằng `chat.get`. Hết lượt, bộ nhớ "đã gửi" bị xóa, nên thay đổi muộn (review được duyệt) đi dưới dạng part đầy đủ. Ở side panel, `Message` được memo hóa, mỗi patch chỉ render lại tin nhắn đổi.

Transcript được lưu sau 2 giây yên lặng, bất đồng bộ (`ChatStore.saveAsync`); lúc đóng chat thì lưu đồng bộ. Mỗi lần lưu tăng "thế hệ" của khóa; bản ghi nền thấy có thế hệ mới hơn (lần lưu sau, lưu đồng bộ, hay `remove`) thì bỏ, nên không ghi đè dữ liệu mới hay làm sống lại transcript đã xóa.

## Ảnh trong kết quả tool

`normalizeIpynbOutput` giữ PNG/JPEG (base64, tối đa ~1,5 MB mỗi ảnh) trong `CellOutput.image`. Ở bridge, `Attachments` (`notebook/tools.ts`) gom ảnh cho một kết quả, tối đa 4 ảnh và 3 MB; trong text, chỗ của ảnh được thay bằng nhãn "image N attached". Relay stdio (`mcp-stdio.ts`) gửi chúng thành MCP image content sau phần text. Có gửi ảnh hay không do `AgentSpec.images` quyết định, nếu không đặt thì theo `promptCapabilities.image` agent khai báo khi `initialize`. `wait_for_cells` chỉ đọc trạng thái chạy khi chờ và lấy output một lần ở cuối, để không chuyển ảnh mỗi giây.

## Notebook only

`ChatSettings.notebookOnly` (mặc định bật). `Chat.onPermission` trả lời ngay bằng lựa chọn từ chối cho mọi yêu cầu quyền không thuộc tool notebook, và ghi một notice vào transcript. Tool notebook nhận ra qua tên (`isNotebookTool`) hoặc qua tool call cùng id đã được đánh dấu là notebook. `<notebook-context>` báo cho agent biết chế độ này.

## Bảo mật

Xem README. Hai điểm thiết kế đáng nhớ:

- WebSocket không bị CORS chặn, nên bridge kiểm tra cả Origin lẫn pairing token.
- Content script chỉ chuyển lên dữ liệu notebook; trang web không thể khiến bridge chạy agent.
