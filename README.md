# Agent in Notebook

Cầu nối giữa **coding agent chạy trên máy bạn** (Claude Code, Codex, Gemini CLI, OpenCode, hoặc bất kỳ agent nào nói [ACP](https://agentclientprotocol.com)) và **notebook** Google Colab, Kaggle, Jupyter. Bạn chat với agent trong **VS Code**; notebook mở trong VS Code hoặc trong tab Chrome; agent làm việc ngay trên máy notebook chạy (VM của Colab/Kaggle).

```
┌─ VS Code ───────────────────────┐        ┌─ Bridge (máy bạn, 127.0.0.1) ─────────┐
│ sidebar chat: chọn notebook,    │  WS +  │ chạy agent qua ACP (mỗi chat 1 agent) │
│   agent, mode; duyệt diff       │ token  │ MCP server "notebook" cấp tool cho    │
│ notebook mở trong VS Code       │◄──────►│   agent: Bash, Read, Edit… trên máy   │
└─────────────────────────────────┘        │   của notebook                        │
┌─ Chrome extension (không giao diện) ┐    │ kiểm tra mode trên MỌI lời gọi tool   │
│ page script: đọc/sửa/chạy cell      │◄──►│                                       │
│   Colab (API nội bộ + diff inline)  │    └───────────────────────────────────────┘
│   Kaggle / Jupyter (JupyterLab 4)   │
└─────────────────────────────────────┘
```

## Tính năng

| Mode | Agent được làm gì |
|---|---|
| **Edit cell** | Chỉ sửa cell đang chọn (hoặc cell bạn ghim). Không thêm/xóa cell, không chạy. |
| **Write** | Viết tự do: thêm cell code và markdown, sửa, xóa, di chuyển. **Không chạy.** File trên máy của notebook chỉ được đọc, không được sửa. |
| **Autonomous** | Toàn quyền: sửa và chạy từng cell hoặc cả notebook, đọc output, interrupt kernel, dùng terminal và sửa file trên máy của notebook, chạy code trên kernel mà không tạo cell. |
| **Review** (bật/tắt, dùng chung với mọi mode) | Mỗi thay đổi hiện thành diff để bạn **Apply** hoặc **Reject**. Đang ở Autonomous thì việc chạy cell, lệnh shell hay đoạn code cũng phải được bạn cho phép (hộp xác nhận hiện đúng lệnh sẽ chạy). |

- Trên Colab, diff hiện bằng giao diện **Accept / Reject có sẵn của Colab** ngay trong cell, đồng thời hiện trong chat ở VS Code. Bấm ở đâu cũng được.
- Trên Kaggle/Jupyter, extension chèn thẻ diff vào ngay trên cell.
- Đổi mode giữa chừng có hiệu lực ngay từ lời gọi tool tiếp theo của agent.
- Đổi agent giữa cuộc trò chuyện được: agent mới nhận tóm tắt cuộc trò chuyện. Agent bị crash sẽ được khởi động lại kèm tóm tắt.
- Mỗi notebook có cuộc trò chuyện riêng, được lưu lại: reload tab, đóng tab rồi mở lại, hay khởi động lại bridge đều thấy lại lịch sử (agent nhận tóm tắt). Mở notebook khác trong cùng tab thì chat của notebook cũ được lưu và đóng lại. Nút **＋ (New chat)** xóa lịch sử đã lưu của notebook đó.
- Sidebar có một ô chọn notebook khi đang mở nhiều notebook (trong VS Code và trong các tab Chrome). Chat tự theo notebook bạn vừa đưa lên trước: chuyển sang một tab Colab trong Chrome, hay mở một notebook trong VS Code.
- **Hoàn tác theo lượt**: dưới mỗi câu trả lời có sửa notebook có dòng "N notebook changes · Undo". Bấm Undo (rồi xác nhận) để đưa notebook về như trước lượt đó: cell bị sửa lấy lại nội dung cũ, cell agent thêm bị xóa, cell agent xóa được chèn lại đúng chỗ, cell bị di chuyển về vị trí cũ. Cell nào bạn (hoặc một lượt sau) đã sửa thì được giữ nguyên và được liệt kê ra. Review được chấp nhận cũng tính vào lượt đã đề xuất nó. Lần gửi tin tiếp theo, agent được báo là thay đổi đã bị hoàn tác. Hoàn tác được cả sau khi khởi động lại bridge, vì nhật ký được lưu cùng lịch sử chat.
- Trang notebook reload khi một thay đổi đang chờ duyệt thì thay đổi đó được đánh dấu **Discarded** (không áp dụng) và agent được báo để đọc lại notebook.
- Chọn model, effort, mode riêng của từng agent ngay trong sidebar (lấy từ agent qua ACP).
- Giao diện chat (một số ý tưởng tham khảo từ [T3 Code](https://github.com/pingdotgg/t3code)): các tool call liền nhau gom thành một dòng tóm tắt ("Read ×3 · Edited · Ran ×2"), bấm để xem từng lệnh; khối code có nút **Copy** và **Insert as cell** (chèn thành cell mới ngay dưới cell đang chọn); câu hỏi xin quyền được ghim phía trên ô nhập; đồng hồ thời gian chạy; dòng tóm tắt khi agent đang suy nghĩ; ↑/↓ trong ô nhập trống để gọi lại tin nhắn cũ; nút **↓ New messages** khi bạn đang cuộn lên.
- **Agent làm việc ngay trên máy của notebook** (VM của Colab/Kaggle), như trên máy của chính nó: bridge cấp bộ tool quen thuộc `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, tất cả chạy trên VM, đường dẫn tương đối tính từ thư mục làm việc của notebook (`/content` trên Colab, `/kaggle/working` trên Kaggle). Với Claude Code, các tool Bash/Read/Edit… gốc trên máy bạn bị tắt hẳn để agent không nhầm hai máy; agent khác được dặn trong luật làm việc và bị "Notebook only" chặn.
- **Notebook là một file `.ipynb` thật** nằm trong thư mục làm việc (ví dụ `/content/Untitled0.ipynb`), luôn khớp với notebook trên trình duyệt theo cả hai chiều:
  - `Read` hiện file thành các cell kèm output (cả ảnh biểu đồ). Nội dung lấy thẳng từ trình duyệt, nên vẫn đọc được khi một cell đang chạy.
  - `Edit` sửa đoạn chữ trong một cell, `NotebookEdit` thay, chèn, xóa hoặc di chuyển cell, `Write` thay cả notebook (JSON `.ipynb`). Mọi thay đổi đi vào editor theo mode và Review như cũ, kết quả duyệt trả về ngay trong lượt gọi tool.
  - Lệnh trong terminal cũng được sửa file (`python`, `jq`, `jupytext`, `nbformat`…). Sau mỗi lệnh, bridge so file với bản đã ghi, theo id của cell, rồi áp phần khác biệt vào trình duyệt. Phần mode không cho phép hoặc bạn từ chối thì bị trả lại trong file, và agent được báo.
  - Bạn sửa cell hay chạy ra output mới thì file được ghi lại trước lần kế tiếp agent đụng tới máy. Cell bạn đang sửa mà agent cũng sửa thì giữ bản của bạn.
  - Output và `execution_count` trong file chỉ để đọc: chúng đến từ việc chạy cell.
  - Nếu chỗ đó đã có file không do bridge ghi (ví dụ chính file notebook của một Jupyter server), file của agent đổi tên thành `<tên>.agent.ipynb` và file kia được để yên.
  - Giao diện ở VS Code cũng vậy: file nằm trên máy của kernel (ví dụ `/content/<tên>.ipynb` trên VM Colab khi chọn kernel Colab trong VS Code) và khớp với Notebook Editor của VS Code. Nếu kernel chạy ngay trên máy bạn, trong thư mục của notebook, thì file `.ipynb` của bạn được để yên và file của agent là `<tên>.agent.ipynb`.
  - Các tool sửa cell kiểu cũ (`list_cells`, `read_cells`, `edit_cell`, `update_cell`, `insert_cell`, `delete_cell`, `move_cell`) đã bỏ.
- Agent **nhìn thấy biểu đồ**: output dạng PNG/JPEG (matplotlib, seaborn…) được gửi kèm kết quả `run_cells`, `wait_for_cells` và `Read` file notebook dưới dạng ảnh, tối đa 4 ảnh mỗi lần gọi. `Read` một file PNG/JPEG trên VM cũng trả về ảnh. Agent nào không đọc được ảnh thì chỉ nhận dòng ghi chú như trước.
- **Tiết kiệm ngữ cảnh**: output dài được rút gọn trước khi tới agent. Thanh tiến trình (tqdm, Keras) chỉ giữ trạng thái cuối, dòng lặp lại được gộp, log được cắt theo dòng (giữ đầu và nhiều phần cuối hơn) và lỗi luôn giữ dòng `ValueError: …` cùng frame trong code của bạn. Một lần `run_all` gói trong khoảng 30k ký tự dù chạy bao nhiêu cell. Khi cần xem phần bị cắt, agent dùng tool `read_output` để tìm (regex) hoặc đọc theo trang. Ảnh dán trong markdown (data URI) hiện thành nhãn ngắn và được giữ nguyên khi agent sửa cell. Outline notebook chỉ gửi lại khi nó thay đổi. Khi agent tự nén context (ví dụ Claude Code auto-compact hoặc `/compact`), luật làm việc với notebook được gửi lại ở tin nhắn kế tiếp. Sidebar hiện mức đầy context (ví dụ `53k/200k`) nếu agent báo qua ACP.
- **Terminal trên máy của notebook** (tool `Bash`, chỉ ở Autonomous): agent có terminal trên VM của Colab/Kaggle và dùng như terminal trên máy mình. Mỗi phiên là một bash interactive thật trong pseudo-terminal: `cd`, biến môi trường, venv đã kích hoạt còn nguyên giữa các lệnh; phiên sống qua lúc restart kernel; mở nhiều phiên theo tên để chạy song song (server ở phiên này, lệnh ở phiên kia). Lệnh chạy tới khi xong, không giới hạn thời gian: nếu chưa xong khi lượt gọi tool hết giờ, agent nhận output tới lúc đó rồi đợi tiếp (`shell_wait`), gõ trả lời (`shell_input`, ví dụ `y` cho prompt y/N) hoặc bấm Ctrl+C (`shell_interrupt`). Agent đọc đúng những gì màn hình terminal hiển thị: thanh tiến trình ở trạng thái cuối, dòng vẽ lại được vẽ lại, chương trình toàn màn hình (less, vim, htop) hiện thành màn hình của nó. Output của job chạy nền in ra giữa các lệnh cũng được báo. Muốn xem phiên của agent trong terminal của Colab/Kaggle: `tail -f /tmp/ainb-shell-$(id -u)/main/out`.
- **Chạy code không cần cell** (chỉ ở Autonomous): `run_code` chạy code trong namespace của notebook (xem `df.shape`, cấu hình model…) mà không thêm cell và không đổi lịch sử thực thi. Code chạy tới khi xong như một cell; chạy lâu thì agent nhận run id để đợi tiếp (`wait_for_code`).
- **Cell đang chạy không chặn agent** (notebook Kaggle, Jupyter mở trong Chrome): bridge chạm tới VM qua một terminal của chính Jupyter server, không qua kernel. Trong lúc bạn train một cell cả tiếng, agent vẫn đọc log, sửa file, gõ lệnh như thường. Trang mở một terminal ẩn trên server (thấy được trong danh sách Running terminals) và đóng nó khi bạn đóng tab; nếu không đóng được thì nó tự kết thúc sau 15 phút không dùng. Terminal của agent bắt đầu ở thư mục làm việc của kernel và nhận PATH của kernel, nên `python`, `pip` trong đó là của notebook. Nhờ đường này, notebook dùng kernel R/Julia cũng có terminal (máy chủ Jupyter luôn có Python).
- **Giới hạn trên Colab: mỗi lúc chỉ một việc.** Colab không cho mượn terminal của server, nên terminal và file trên máy Colab đi qua kernel. Khi một cell đang chạy:
  - agent vẫn đọc và sửa notebook được (phần này đi thẳng vào trang Colab, kể cả khi chưa kết nối runtime);
  - terminal và file trên máy Colab phải chờ cell chạy xong; lệnh đã chạy trong terminal vẫn chạy tiếp, chỉ là agent chưa xem được;
  - agent được báo trước giới hạn này và được báo lại khi gặp phải.

  So sánh: trên **Kaggle** (và Jupyter), notebook và terminal làm song song được cả khi cell đang chạy. Colab sẽ làm được như vậy qua SSH chính thức của Colab khi dùng gói trả phí (xem [docs/du-dinh-colab.md](docs/du-dinh-colab.md)). Server không có terminal (hoặc chạy Windows), và notebook mở trong VS Code, cũng đi qua kernel như Colab; terminal cần máy Linux/macOS.
- **Notebook only** (bật mặc định): mọi yêu cầu xin quyền dùng tool riêng của agent trên máy bạn (shell, sửa file, web…) bị từ chối ngay, vì nội dung notebook có thể chứa lệnh nhằm dụ agent. Tool notebook vẫn hỏi bạn như thường. Tắt công tắc này thì các yêu cầu đó được chuyển lên sidebar để bạn quyết. Lưu ý: tool mà agent tự chạy không cần xin quyền thì không bị chặn.

## Định dạng trong chat

Tin nhắn hỗ trợ Markdown, bảng, checklist, code block và URL có thể bấm. Đặt công thức trong `$...$` hoặc `\(...\)` để hiện cùng dòng. Dùng `$$...$$`, `\[...\]` hoặc code block có nhãn `math` để hiện riêng một khối.

Dùng `![Mô tả](https://example.com/plot.png)` để hiện ảnh ngay trong tin nhắn. Chat cũng hiển thị ảnh raster nhúng, ảnh do agent gửi qua ACP và biểu đồ do lệnh chạy notebook của agent tạo ra. Trong VS Code, `![Biểu đồ](./plots/loss.png)` có thể đọc ảnh từ workspace hoặc thư mục notebook khi cửa sổ không mở workspace.

Trong VS Code, link Markdown như `[Xem dòng 12](./src/main.py:12)` mở file ở dòng tương ứng trong workspace. Nếu cửa sổ không mở workspace, đường dẫn được giới hạn trong thư mục của notebook. Link web mở bằng trình duyệt.

## Cài đặt

Cần Node ≥ 20, pnpm, VS Code ≥ 1.105, và Chrome ≥ 116 nếu dùng notebook trên web.

```sh
pnpm install
pnpm build
```

**1. Bridge**

```sh
pnpm bridge            # = node packages/bridge/dist/cli.js serve
```

Bridge in ra **pairing token** và ghi nó vào `~/.agent-in-notebook/config.json`; VS Code đọc file này nên thường không cần dán token. In lại token: `pnpm ainb token`. Đổi token: thêm `--reset`.

**2. VS Code: nơi bạn chat**

Chạy thử từ mã nguồn, trong một terminal khác ở thư mục repo:

```sh
code --extensionDevelopmentPath="${PWD}/packages/vscode"
```

Hoặc cài vào VS Code đang dùng hằng ngày:

```sh
cd packages/vscode
pnpm dlx @vscode/vsce@4.1.1 package --no-dependencies --skip-license
code --install-extension agent-in-notebook-vscode-0.1.0.vsix
```

Bấm **Agent in Notebook** trên Activity Bar (hoặc **Agent in Notebook: Open Chat** trong Command Palette). Nếu bridge dùng port khác, chọn **Enter pairing token** để nhập port và token.

**3. Chrome: notebook Colab/Kaggle trên web**

`chrome://extensions` → bật *Developer mode* → *Load unpacked* → chọn `packages/extension/dist`. ID của extension cố định (`mkdjlgboacefhokakjlobfailhipgklf`, nhờ trường `key` trong manifest). Sau đó đăng ký bridge với trình duyệt một lần:

```sh
pnpm ainb install      # = node packages/bridge/dist/cli.js install
```

Lệnh này đăng ký bridge làm *native messaging host* cho Chrome, Chromium, Edge và Brave (trên Windows: khóa registry trong `HKCU`, không cần quyền admin). Extension Chrome không có giao diện chat: khi bạn mở một notebook Colab hoặc Kaggle, nó tự bật bridge nếu bridge chưa chạy, tự ghép nối, và notebook hiện ra trong ô chọn notebook của sidebar VS Code. Biểu tượng của extension có dấu **!** khi chưa nối được bridge; bấm vào biểu tượng để thử lại (di chuột lên để xem lý do). Nếu bạn chuyển thư mục project hoặc đổi bản Node, hãy chạy lại `install`. Gỡ đăng ký bằng `pnpm ainb uninstall`.

Bridge được bật theo cách này chạy nền và ghi log vào `~/.agent-in-notebook/bridge.log`. Các lệnh đi kèm: `pnpm ainb status`, `pnpm ainb stop`. Sau `stop`, extension không tự bật lại bridge cho tới khi bạn mở (hoặc reload) một notebook, hay bấm vào biểu tượng của extension.

**4. Dùng**

- Notebook trên web: mở notebook Colab hoặc Kaggle trong Chrome (ở chế độ chỉnh sửa), rồi chat ở sidebar VS Code. Nếu notebook đã mở từ trước khi cài extension, hãy reload tab một lần.
- Notebook trong VS Code: mở file `.ipynb` bằng Notebook Editor. Để chạy cell, cài **Jupyter** trong VS Code và chọn kernel ở **Select Kernel**; muốn dùng GPU/TPU của Colab, cài thêm extension **Colab** của Google và chọn kernel Colab. Chạy một cell để khởi động kernel và cấp quyền kernel cho Agent in Notebook khi Jupyter hỏi. Lưu notebook bằng Save của VS Code. Các cell cũ chưa có ID trong `.ipynb` có ID tạm trong phiên mở tài liệu, nên hoàn tác theo lượt với các cell đó cần làm trước khi đóng notebook.

Dù notebook mở ở đâu, agent vẫn làm việc trên máy của notebook (VM Colab/Kaggle, server Jupyter, hay máy bạn với kernel local), với terminal, file và file notebook ở đó.

### Agent

| Agent | Cách chạy | Đăng nhập |
|---|---|---|
| Claude Code | adapter `@agentclientprotocol/claude-agent-acp` (cài sẵn cùng bridge) | `claude` một lần, hoặc `ANTHROPIC_API_KEY` |
| Codex | adapter `@agentclientprotocol/codex-acp` (cài sẵn) | `codex login`, hoặc `OPENAI_API_KEY` |
| Gemini CLI | `gemini --acp` | `GEMINI_API_KEY` (Google đã ngừng cho tài khoản cá nhân đăng nhập OAuth dùng Gemini CLI) |
| OpenCode | `opencode acp` | `opencode auth login` |

### Thêm agent ACP

Bạn có thể thêm, sửa, xóa và **Test connection** ngay trong sidebar qua **Manage agents**. Chỉ cần nhập launch command; tên có thể để trống. Ví dụ: `dsh --profile acp` (DeepSeek Harness) hoặc `claude-fp-acp` (launcher Claude FP đã cài trên máy). Lệnh chạy trên máy đang chạy bridge và dùng lại đăng nhập của agent. Đường dẫn hoặc tham số có khoảng trắng cần đặt trong dấu nháy.

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
