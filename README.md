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
- Chọn model, effort, mode riêng của từng agent ngay trong side panel (lấy từ agent qua ACP).
- Khi agent muốn dùng tool của chính nó (shell, đọc file…), yêu cầu xin quyền được chuyển lên side panel để bạn quyết.

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

Thêm agent ACP bất kỳ bằng file `~/.agent-in-notebook/agents.json`:

```json
[
  { "id": "goose", "name": "Goose", "command": "goose", "args": ["acp"], "toolWaitSeconds": 120 }
]
```

`toolWaitSeconds` là thời gian tối đa một tool call được chờ, ví dụ chờ bạn duyệt diff hoặc chờ cell chạy, trước khi trả "vẫn đang chờ" để agent gọi tiếp `await_review` / `wait_for_cells`. Codex chỉ cho tool MCP 60 giây nên bridge để mức 50 giây cho Codex.

### Jupyter trên máy

Jupyter Notebook 7 (cùng editor mà Kaggle nhúng) dùng được khi chạy với cờ bật API trong trình duyệt:

```sh
jupyter notebook --JupyterNotebookApp.expose_app_in_browser=True
```

## Bảo mật

- Bridge chỉ nghe trên `127.0.0.1`. WebSocket chỉ nhận origin `chrome-extension://` **và** đúng pairing token, nên trang web lạ không gọi vào được.
- Mỗi chat có một token riêng cho MCP relay. Relay từ chối mọi request có header `Origin` (tức là đến từ trình duyệt).
- Agent chạy trong thư mục riêng `~/.agent-in-notebook/workspaces/<chat>`. Bridge không sửa config của agent. Mọi yêu cầu xin quyền của agent đều tới tay bạn, và yêu cầu nào không được trả lời thì bị từ chối.
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
