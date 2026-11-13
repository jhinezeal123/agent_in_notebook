# Agent in Notebook

Cầu nối giữa **coding agent chạy trên máy bạn** (Claude Code, Codex, Gemini CLI, OpenCode, hoặc bất kỳ agent nào nói [ACP](https://agentclientprotocol.com)) và **notebook** trong VS Code hoặc trình duyệt (Google Colab, Kaggle, Jupyter).

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
| **Autonomous** | Toàn quyền: sửa và chạy từng cell hoặc cả notebook, đọc output, interrupt kernel, dùng terminal trên máy của notebook, chạy code trên kernel mà không tạo cell. |
| **Review** (bật/tắt, dùng chung với mọi mode) | Mỗi thay đổi hiện thành diff để bạn **Apply** hoặc **Reject**. Đang ở Autonomous thì việc chạy cell, lệnh shell hay đoạn code cũng phải được bạn cho phép (hộp xác nhận hiện đúng lệnh sẽ chạy). |

- Trên Colab, diff hiện bằng giao diện **Accept / Reject có sẵn của Colab** ngay trong cell, đồng thời hiện trong side panel. Bấm ở đâu cũng được.
- Trên Kaggle/Jupyter, extension chèn thẻ diff vào ngay trên cell.
- Đổi mode giữa chừng có hiệu lực ngay từ lời gọi tool tiếp theo của agent.
- Đổi agent giữa cuộc trò chuyện được: agent mới nhận tóm tắt cuộc trò chuyện. Agent bị crash sẽ được khởi động lại kèm tóm tắt.
- Mỗi notebook có cuộc trò chuyện riêng, được lưu lại: reload tab, đóng tab rồi mở lại, hay khởi động lại bridge đều thấy lại lịch sử (agent nhận tóm tắt). Mở notebook khác trong cùng tab thì chat của notebook cũ được lưu và đóng lại. Nút **＋ (New chat)** xóa lịch sử đã lưu của notebook đó.
- **Hoàn tác theo lượt**: dưới mỗi câu trả lời có sửa notebook có dòng "N notebook changes · Undo". Bấm Undo (rồi xác nhận) để đưa notebook về như trước lượt đó: cell bị sửa lấy lại nội dung cũ, cell agent thêm bị xóa, cell agent xóa được chèn lại đúng chỗ, cell bị di chuyển về vị trí cũ. Cell nào bạn (hoặc một lượt sau) đã sửa thì được giữ nguyên và được liệt kê ra. Review được chấp nhận cũng tính vào lượt đã đề xuất nó. Lần gửi tin tiếp theo, agent được báo là thay đổi đã bị hoàn tác. Hoàn tác được cả sau khi khởi động lại bridge, vì nhật ký được lưu cùng lịch sử chat.
- Trang notebook reload khi một thay đổi đang chờ duyệt thì thay đổi đó được đánh dấu **Discarded** (không áp dụng) và agent được báo để đọc lại notebook.
- Chọn model, effort, mode riêng của từng agent ngay trong side panel (lấy từ agent qua ACP).
- Giao diện chat (một số ý tưởng tham khảo từ [T3 Code](https://github.com/pingdotgg/t3code)): các tool call liền nhau gom thành một dòng tóm tắt ("Read ×3 · Edited · Ran ×2"), bấm để xem từng lệnh; khối code có nút **Copy** và **Insert as cell** (chèn thành cell mới ngay dưới cell đang chọn); câu hỏi xin quyền được ghim phía trên ô nhập; đồng hồ thời gian chạy; dòng tóm tắt khi agent đang suy nghĩ; ↑/↓ trong ô nhập trống để gọi lại tin nhắn cũ; nút **↓ New messages** khi bạn đang cuộn lên.
- Agent **nhìn thấy biểu đồ**: output dạng PNG/JPEG (matplotlib, seaborn…) được gửi kèm kết quả `run_cells`, `read_cells`, `wait_for_cells` dưới dạng ảnh, tối đa 4 ảnh mỗi lần gọi. Agent nào không đọc được ảnh thì chỉ nhận dòng ghi chú như trước.
- **Tiết kiệm ngữ cảnh**: output dài được rút gọn trước khi tới agent. Thanh tiến trình (tqdm, Keras) chỉ giữ trạng thái cuối, dòng lặp lại được gộp, log được cắt theo dòng (giữ đầu và nhiều phần cuối hơn) và lỗi luôn giữ dòng `ValueError: …` cùng frame trong code của bạn. Một lần `run_all` gói trong khoảng 30k ký tự dù chạy bao nhiêu cell. Khi cần xem phần bị cắt, agent dùng tool `read_output` để tìm (regex) hoặc đọc theo trang. Ảnh dán trong markdown (data URI) hiện thành nhãn ngắn và được giữ nguyên khi agent sửa cell. Outline notebook chỉ gửi lại khi nó thay đổi. Khi agent tự nén context (ví dụ Claude Code auto-compact hoặc `/compact`), luật làm việc với notebook được gửi lại ở tin nhắn kế tiếp. Side panel hiện mức đầy context (ví dụ `53k/200k`) nếu agent báo qua ACP.
- **Terminal trên máy của notebook** (chỉ ở Autonomous): agent có terminal trên VM của Colab/Kaggle và dùng như terminal trên máy mình. Mỗi phiên là một bash interactive thật trong pseudo-terminal: `cd`, biến môi trường, venv đã kích hoạt còn nguyên giữa các lệnh; phiên sống qua lúc restart kernel; mở nhiều phiên theo tên để chạy song song (server ở phiên này, lệnh ở phiên kia). Lệnh chạy tới khi xong, không giới hạn thời gian: nếu chưa xong khi lượt gọi tool hết giờ, agent nhận output tới lúc đó rồi đợi tiếp (`shell_wait`), gõ trả lời (`shell_input`, ví dụ `y` cho prompt y/N) hoặc bấm Ctrl+C (`shell_interrupt`). Agent đọc đúng những gì màn hình terminal hiển thị: thanh tiến trình ở trạng thái cuối, dòng vẽ lại được vẽ lại, chương trình toàn màn hình (less, vim, htop) hiện thành màn hình của nó. Output của job chạy nền in ra giữa các lệnh cũng được báo. Muốn xem phiên của agent trong terminal của Colab/Kaggle: `tail -f /tmp/ainb-shell-$(id -u)/main/out`.
- **Chạy code không cần cell** (chỉ ở Autonomous): `run_code` chạy code trong namespace của notebook (xem `df.shape`, cấu hình model…) mà không thêm cell và không đổi lịch sử thực thi. Code chạy tới khi xong như một cell; chạy lâu thì agent nhận run id để đợi tiếp (`wait_for_code`).
- Giới hạn của terminal: bridge đọc và ghi terminal thông qua kernel (gửi những đoạn Python ngắn), nên khi kernel đang chạy một cell thì tạm thời không đọc được output của terminal. Lệnh trong terminal không bị ảnh hưởng, cell chạy xong là đọc tiếp được. Cần kernel Python trên Linux/macOS (Colab, Kaggle đều vậy).
- **Notebook only** (bật mặc định): mọi yêu cầu xin quyền dùng tool riêng của agent trên máy bạn (shell, sửa file, web…) bị từ chối ngay, vì nội dung notebook có thể chứa lệnh nhằm dụ agent. Tool notebook vẫn hỏi bạn như thường. Tắt công tắc này thì các yêu cầu đó được chuyển lên side panel để bạn quyết. Lưu ý: tool mà agent tự chạy không cần xin quyền thì không bị chặn.

## Định dạng trong chat

Tin nhắn hỗ trợ Markdown, bảng, checklist, code block và URL có thể bấm. Đặt công thức trong `$...$` hoặc `\(...\)` để hiện cùng dòng. Dùng `$$...$$`, `\[...\]` hoặc code block có nhãn `math` để hiện riêng một khối.

Trong VS Code, link Markdown như `[Xem dòng 12](./src/main.py:12)` mở file ở dòng tương ứng trong workspace. Nếu cửa sổ không mở workspace, đường dẫn được giới hạn trong thư mục của notebook. Link web mở bằng trình duyệt.

## Dùng trong VS Code

Extension **Agent in Notebook** mở giao diện chat ở sidebar cạnh Notebook Editor của VS Code. Agent đọc, sửa và chạy cell trên tài liệu `.ipynb` đang mở. Sidebar theo notebook đang chọn và hiển thị diff để **Apply / Reject**. Lịch sử chat được lưu theo đường dẫn notebook.

**Chạy thử từ mã nguồn** với VS Code 1.105 trở lên. Từ thư mục repo:

```sh
pnpm install
pnpm build
pnpm bridge
```

Mở terminal khác trong cùng thư mục, sau đó chạy:

```sh
code --extensionDevelopmentPath="${PWD}/packages/vscode"
```

Trong cửa sổ **Extension Development Host**, mở một file `.ipynb` bằng Notebook Editor. Bấm **Agent in Notebook** trên Activity Bar hoặc chạy **Agent in Notebook: Open Chat** từ Command Palette. Chọn agent rồi gửi tin. Sidebar đọc port và pairing token từ cấu hình bridge trên cùng máy. Nếu bridge dùng port khác, chọn **Enter pairing token** để nhập port và token.

Để chạy cell, cài **Jupyter** trong VS Code và chọn kernel ở **Select Kernel**. Muốn dùng GPU/TPU của Colab, cài thêm extension **Colab** của Google và chọn kernel Colab. `run_code` và các tool terminal của notebook dùng API kernel của Jupyter. Chạy một cell để khởi động kernel và cấp quyền kernel cho Agent in Notebook khi Jupyter hỏi. Với Kaggle, tải `.ipynb` về để mở trong VS Code và chọn kernel có sẵn ở đó. Runtime Kaggle đang chạy trong tab web chỉ được kết nối qua bản Chrome bên dưới.

Nếu muốn cài vào VS Code đang dùng hằng ngày, đóng gói từ repo đã build:

```sh
cd packages/vscode
pnpm dlx @vscode/vsce@4.1.1 package --no-dependencies --skip-license
code --install-extension agent-in-notebook-vscode-0.1.0.vsix
```

Lưu notebook bằng thao tác Save của VS Code. Undo theo lượt trong sidebar chỉ hoàn tác cell còn khớp với bản agent sửa. Các cell cũ chưa có ID trong `.ipynb` có ID tạm trong phiên mở tài liệu, nên hoàn tác các cell đó cần thực hiện trước khi đóng notebook.

## Cài đặt bản Chrome

Cần Node ≥ 20, pnpm và Chrome ≥ 116.

```sh
pnpm install
pnpm build
```

**1. Nạp extension**

`chrome://extensions` → bật *Developer mode* → *Load unpacked* → chọn `packages/extension/dist`. ID của extension cố định (`mkdjlgboacefhokakjlobfailhipgklf`, nhờ trường `key` trong manifest). Nếu bạn đã nạp bản cũ hơn (chưa có `key`), hãy gỡ nó ra rồi nạp lại.

**2. Đăng ký bridge với trình duyệt (một lần)**

```sh
pnpm ainb install      # = node packages/bridge/dist/cli.js install
```

Lệnh này đăng ký bridge làm *native messaging host* cho Chrome, Chromium, Edge và Brave. Trên Windows nó ghi khóa registry trong `HKCU`, không cần quyền admin. Từ đó, khi bạn mở side panel, extension tự bật bridge nếu bridge chưa chạy và tự ghép nối, không cần mở terminal hay dán token. Nếu bạn chuyển thư mục project hoặc đổi bản Node, hãy chạy lại `install`. Gỡ đăng ký bằng `pnpm ainb uninstall`.

Bridge được bật theo cách này sẽ chạy nền và ghi log vào `~/.agent-in-notebook/bridge.log`. Các lệnh đi kèm: `pnpm ainb status`, `pnpm ainb stop`. Sau `stop`, extension không tự bật lại bridge cho tới khi bạn bấm **Start the bridge** hoặc mở lại side panel.

Vẫn có thể chạy bridge bằng tay như trước, chẳng hạn để xem log trực tiếp hoặc khi bridge chạy trong WSL:

```sh
pnpm bridge            # = node packages/bridge/dist/cli.js serve
```

Bridge in ra **pairing token**; dán token đó vào mục *Connect with a pairing token instead* trên side panel. In lại token: `pnpm ainb token`. Đổi token: thêm `--reset`.

**3. Dùng**

Mở một notebook Colab hoặc Kaggle (ở chế độ chỉnh sửa), bấm icon extension để mở side panel, chọn agent, chọn mode, rồi chat. Nếu notebook đã mở từ trước khi cài extension, hãy reload tab một lần.

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

- Bridge chỉ nghe trên `127.0.0.1`. WebSocket `/ext` kiểm tra origin của extension trình duyệt. `/vscode` dành cho VS Code Extension Host và từ chối request có header `Origin`. Cả hai cần đúng pairing token.
- Native messaging: trình duyệt chỉ cho extension có ID nằm trong `allowed_origins` gọi native host, nên chỉ extension này nhận được token từ host. `POST /shutdown` (`ainb stop`) cần pairing token và bị từ chối nếu có header `Origin`.
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

# Native messaging: đăng ký host cho trình duyệt của user (gỡ lại sau khi chạy xong)
E2E_NATIVE=1 pnpm --filter @ainb/extension exec vitest run test/native-e2e.test.ts
```

`AINB_DEBUG=1 pnpm bridge` in toàn bộ luồng ACP của agent (update, xin quyền, stderr).

Cấu trúc: `packages/protocol` (kiểu dữ liệu, policy của mode, diff, RPC, `OpRunner`), `packages/bridge` (server, agent, tool notebook), `packages/extension` (adapter Colab/Jupyter, background, giao diện chat dùng chung), `packages/vscode` (sidebar và adapter Notebook Editor). Chi tiết thiết kế: [docs/architecture.md](docs/architecture.md).

## Giới hạn đã biết

- Colab không có API công khai. Adapter dùng object nội bộ `colab.global.notebook` và bộ tool agent của chính Colab (`add_code_cell`, `run_code_cell`…), tìm theo tên tool, nên một bản cập nhật của Colab có thể làm hỏng. Lỗi khi đó sẽ ghi rõ tool nào không còn.
- Kaggle được kiểm thử trên Jupyter Notebook 7.0.6 chạy local (đúng bản Kaggle nhúng). Chưa chạy thử trên trang Kaggle thật vì cần đăng nhập.
- Thẻ review trên JupyterLab kích hoạt khi **nhấn** chuột (JupyterLab nuốt sự kiện thả chuột bên trong cell).
- Chạy cell trên Colab cần runtime đã kết nối, nghĩa là đã đăng nhập Google.
