# Agent in Notebook

Cầu nối giữa **coding agent chạy trên máy bạn** (Claude Code, Codex, Gemini CLI, OpenCode, hoặc bất kỳ agent nào nói [ACP](https://agentclientprotocol.com)) và **notebook trong trình duyệt** (Google Colab, Kaggle, Jupyter). Giống tính năng Gemini trong Colab, nhưng bạn tự chọn agent và dùng được cả trên Kaggle.

```
┌─ Chrome extension ──────────────────┐        ┌─ Bridge (máy bạn, 127.0.0.1) ─────────┐
│ page script: đọc/sửa/chạy cell      │  WS +  │ chạy agent qua ACP (mỗi chat 1 agent) │
│   Colab (API nội bộ + diff inline)  │ token  │ MCP server "notebook" cấp tool cho    │
│   Kaggle / Jupyter (JupyterLab 4)   │◄──────►│   agent: list/read/edit/insert/run…   │
│ side panel: chat, chọn agent/mode,  │        │ kiểm tra mode trên MỌI lời gọi tool   │
│   duyệt diff → Apply / Reject       │        │                                       │
└─────────────────────────────────────┘        └───────────────────────────────────────┘
```

## Tính năng

| Mode | Agent được làm gì |
|---|---|
| **Edit cell** | Chỉ sửa cell đang chọn (hoặc cell bạn ghim). Không thêm/xóa cell, không chạy. |
| **Write** | Viết tự do: thêm cell code và markdown, sửa, xóa, di chuyển. **Không chạy.** |
| **Autonomous** | Toàn quyền: sửa và chạy từng cell hoặc cả notebook, đọc output, interrupt kernel. |
| **Review** (bật/tắt, dùng chung với mọi mode) | Mỗi thay đổi hiện thành diff để bạn **Apply** hoặc **Reject**. Đang ở Autonomous thì việc chạy cell cũng phải được bạn cho phép. |

- Trên Colab, diff hiện bằng giao diện **Accept / Reject có sẵn của Colab** ngay trong cell, đồng thời hiện trong side panel. Bấm ở đâu cũng được.
- Trên Kaggle/Jupyter, extension chèn thẻ diff vào ngay trên cell.
- Đổi mode giữa chừng có hiệu lực ngay từ lời gọi tool tiếp theo của agent.
- Đổi agent giữa cuộc trò chuyện được: agent mới nhận tóm tắt cuộc trò chuyện. Agent bị crash sẽ được khởi động lại kèm tóm tắt.
- Mỗi notebook có cuộc trò chuyện riêng, được lưu lại: reload tab, đóng tab rồi mở lại, hay khởi động lại bridge đều thấy lại lịch sử (agent nhận tóm tắt). Mở notebook khác trong cùng tab thì chat của notebook cũ được lưu và đóng lại. Nút **＋ (New chat)** xóa lịch sử đã lưu của notebook đó.
- Trang notebook reload khi một thay đổi đang chờ duyệt thì thay đổi đó được đánh dấu **Discarded** (không áp dụng) và agent được báo để đọc lại notebook.
- Chọn model, effort, mode riêng của từng agent ngay trong side panel (lấy từ agent qua ACP).
- Giao diện chat (một số ý tưởng tham khảo từ [T3 Code](https://github.com/pingdotgg/t3code)): các tool call liền nhau gom thành một dòng tóm tắt ("Read ×3 · Edited · Ran ×2"), bấm để xem từng lệnh; khối code có nút **Copy** và **Insert as cell** (chèn thành cell mới ngay dưới cell đang chọn); câu hỏi xin quyền được ghim phía trên ô nhập; đồng hồ thời gian chạy; dòng tóm tắt khi agent đang suy nghĩ; ↑/↓ trong ô nhập trống để gọi lại tin nhắn cũ; nút **↓ New messages** khi bạn đang cuộn lên.
- Agent **nhìn thấy biểu đồ**: output dạng PNG/JPEG (matplotlib, seaborn…) được gửi kèm kết quả `run_cells`, `read_cells`, `wait_for_cells` dưới dạng ảnh, tối đa 4 ảnh mỗi lần gọi. Agent nào không đọc được ảnh thì chỉ nhận dòng ghi chú như trước.
- **Notebook only** (bật mặc định): mọi yêu cầu xin quyền dùng tool riêng của agent trên máy bạn (shell, sửa file, web…) bị từ chối ngay, vì nội dung notebook có thể chứa lệnh nhằm dụ agent. Tool notebook vẫn hỏi bạn như thường. Tắt công tắc này thì các yêu cầu đó được chuyển lên side panel để bạn quyết. Lưu ý: tool mà agent tự chạy không cần xin quyền thì không bị chặn.

## Cài đặt

Cần Node ≥ 20, pnpm và Chrome ≥ 116.

```sh
pnpm install
pnpm build
```

**1. Chạy bridge**

```sh
pnpm bridge            # = node packages/bridge/dist/cli.js serve
```

Bridge in ra **pairing token** và danh sách agent tìm thấy trên máy. In lại token: `node packages/bridge/dist/cli.js token`. Đổi token: thêm `--reset`.

**2. Nạp extension**

`chrome://extensions` → bật *Developer mode* → *Load unpacked* → chọn `packages/extension/dist`.

**3. Dùng**

Mở một notebook Colab hoặc Kaggle (ở chế độ chỉnh sửa), bấm icon extension để mở side panel, dán pairing token, chọn agent, chọn mode, rồi chat. Nếu notebook đã mở từ trước khi cài extension, hãy reload tab một lần.

### Agent

| Agent | Cách chạy | Đăng nhập |
|---|---|---|
| Claude Code | adapter `@agentclientprotocol/claude-agent-acp` (cài sẵn cùng bridge) | `claude` một lần, hoặc `ANTHROPIC_API_KEY` |
| Codex | adapter `@agentclientprotocol/codex-acp` (cài sẵn) | `codex login`, hoặc `OPENAI_API_KEY` |
| Gemini CLI | `gemini --acp` | `GEMINI_API_KEY` (Google đã ngừng cho tài khoản cá nhân đăng nhập OAuth dùng Gemini CLI) |
| OpenCode | `opencode acp` | `opencode auth login` |

### Thêm agent ACP

Bạn có thể thêm, sửa, xóa và **Test connection** ngay trong side panel qua **Manage agents**. Chỉ cần nhập launch command; tên có thể để trống. Ví dụ: `dsh --profile acp` (DeepSeek Harness) hoặc `claude-fp-acp` (launcher Claude FP đã cài trên máy). Lệnh chạy trên máy đang chạy bridge và dùng lại đăng nhập của agent. Đường dẫn hoặc tham số có khoảng trắng cần đặt trong dấu nháy.

Khi chọn agent, extension mở session ACP để tải các lựa chọn model/effort **trước tin nhắn đầu tiên**, chưa gửi prompt đến model. Chọn model xong rồi gửi tin; nút Send sẽ chờ việc đổi model hoàn tất.

Các agent thêm qua giao diện cũng được lưu vào file `~/.agent-in-notebook/agents.json`, nên vẫn có thể quản lý bằng file:

```json
[
  { "id": "goose", "name": "Goose", "command": "goose", "args": ["acp"], "toolWaitSeconds": 120 }
]
```

`images` (tùy chọn, `true`/`false`) quyết định có gửi ảnh biểu đồ cho agent không; mặc định theo khả năng đọc ảnh mà agent khai báo qua ACP. Đã kiểm chứng: Claude Code và Codex đọc được ảnh; OpenCode 2.1.2 (với model đang cấu hình khi thử) thì không, nên bị tắt sẵn. Muốn bật lại cho OpenCode (ví dụ khi dùng model đọc được ảnh), thêm một mục có cùng id để ghi đè agent có sẵn: `{ "id": "opencode", "name": "OpenCode", "command": "opencode", "args": ["acp"], "images": true }`.

`toolWaitSeconds` là thời gian tối đa một tool call được chờ, ví dụ chờ bạn duyệt diff hoặc chờ cell chạy, trước khi trả "vẫn đang chờ" để agent gọi tiếp `await_review` / `wait_for_cells`. Codex chỉ cho tool MCP 60 giây nên bridge để mức 50 giây cho Codex.

### Jupyter trên máy

Jupyter Notebook 7 (cùng editor mà Kaggle nhúng) dùng được khi chạy với cờ bật API trong trình duyệt:

```sh
jupyter notebook --JupyterNotebookApp.expose_app_in_browser=True
```

## Bảo mật

- Bridge chỉ nghe trên `127.0.0.1`. WebSocket chỉ nhận origin `chrome-extension://` **và** đúng pairing token, nên trang web lạ không gọi vào được.
- Mỗi chat có một token riêng cho MCP relay. Relay từ chối mọi request có header `Origin` (tức là đến từ trình duyệt).
- Agent chạy trong thư mục riêng `~/.agent-in-notebook/workspaces/<notebook>` (mỗi notebook một thư mục). Bridge không sửa config của agent.
- Lịch sử chat được lưu ở `~/.agent-in-notebook/chats/` (tối đa 200 tin nhắn gần nhất mỗi notebook). Lịch sử và thư mục làm việc không được dùng trong 30 ngày sẽ bị xóa khi bridge khởi động.
- Chỉ một cửa sổ/profile Chrome được nối với bridge tại một thời điểm. Khi profile khác kết nối, profile cũ dừng lại và không tự giành lại kết nối; bấm **Connect here** để lấy lại. Mọi yêu cầu xin quyền của agent đều tới tay bạn, và yêu cầu nào không được trả lời thì bị từ chối.
- Page script chỉ gửi lên dữ liệu notebook và kết quả op, không thể gửi lệnh chat tới bridge.

## Phát triển

```sh
pnpm test            # protocol + bridge (agent ACP giả, MCP relay thật) + unit test extension
pnpm typecheck

# Agent thật trên máy (tốn chút quota của bạn):
REAL_AGENTS=claude,codex,opencode pnpm --filter @ainb/bridge exec vitest run test/real-agents.test.ts

# E2E trên trình duyệt thật: Chromium + extension + bridge + Colab công khai + Jupyter local
pnpm --filter @ainb/extension exec playwright install chromium
E2E=1 AINB_E2E_JUPYTER=/đường/dẫn/tới/jupyter pnpm --filter @ainb/extension exec vitest run test/e2e.test.ts
```

`AINB_DEBUG=1 pnpm bridge` in toàn bộ luồng ACP của agent (update, xin quyền, stderr).

Cấu trúc: `packages/protocol` (kiểu dữ liệu, policy của mode, diff, RPC), `packages/bridge` (server, agent, tool notebook), `packages/extension` (adapter Colab/Jupyter, background, side panel). Chi tiết thiết kế: [docs/architecture.md](docs/architecture.md).

## Giới hạn đã biết

- Colab không có API công khai. Adapter dùng object nội bộ `colab.global.notebook` và bộ tool agent của chính Colab (`add_code_cell`, `run_code_cell`…), tìm theo tên tool, nên một bản cập nhật của Colab có thể làm hỏng. Lỗi khi đó sẽ ghi rõ tool nào không còn.
- Kaggle được kiểm thử trên Jupyter Notebook 7.0.6 chạy local (đúng bản Kaggle nhúng). Chưa chạy thử trên trang Kaggle thật vì cần đăng nhập.
- Thẻ review trên JupyterLab kích hoạt khi **nhấn** chuột (JupyterLab nuốt sự kiện thả chuột bên trong cell).
- Chạy cell trên Colab cần runtime đã kết nối, nghĩa là đã đăng nhập Google.
