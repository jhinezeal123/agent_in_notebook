# Kiến trúc

Năm package TypeScript trong một pnpm workspace:

| Package | Chạy ở đâu | Vai trò |
|---|---|---|
| `protocol` | mọi phía | Kiểu dữ liệu notebook, giao thức WS, `RpcPeer`, policy của mode (`decide`), diff theo dòng, chuẩn hóa output ipynb, `NotebookAdapter` và `OpRunner` |
| `bridge` | Node, trên máy user | Server WS/HTTP, quản lý chat, chạy agent qua ACP, tool notebook (MCP) |
| `ui` | webview VS Code | Giao diện chat Preact: transcript, Markdown/LaTeX, review, chọn notebook, agent và mode |
| `vscode` | VS Code Extension Host | Nơi duy nhất có chat. Adapter Notebook Editor, `PanelCore` (notebook nào đang được chat, notebook trong tab Chrome), chuyển request của sidebar tới bridge |
| `extension` | Chrome MV3, không giao diện | Adapter notebook trong trang Colab/Kaggle/Jupyter, content script, service worker nối với bridge |

## Giao diện ở VS Code, notebook ở đâu cũng được

Chat chỉ có ở VS Code. Notebook có thể mở trong VS Code hoặc trong một tab Chrome; agent luôn làm việc trên máy của notebook.

```
VS Code ──/vscode──► bridge ◄──/ext── extension Chrome (không giao diện)
 sidebar (ui)          chats: theo id của editor     tab Colab/Kaggle/Jupyter
 PanelCore             đích của mỗi chat:             page script: OpRunner → adapter
 notebook VS Code        {vscode, tabId}  hoặc
                         {browser, tabId Chrome}
```

- **Bridge** (`server.ts`) giữ chat theo id mà editor dùng cho notebook, cùng **đích** của chat. `chat.open` có `browserTab` thì đích là tab Chrome đó: `notebook.op` của agent đi tới extension Chrome, còn snapshot/patch của chat đi về VS Code. Extension Chrome không có phương thức chat nào; nó chỉ báo notebook (`notebook.attached/detached/event`, `tab.closed`) và `notebook.focused` khi user đưa tab lên trước.
- Bridge giữ danh sách notebook trong tab Chrome và báo VS Code (`browser.notebook`, `browser.focused`; `browser.notebooks` để lấy cả danh sách). VS Code tự làm một số việc trên tab Chrome qua `browser.op` (`isBrowserOp` trong protocol): đọc (`info`, `get_cells`), `focus_cell`, `run_cells`, `interrupt`, và sửa cell **của user** (`insert_cell`, `update_cell`, `delete_cell` với `review: false, byUser: true`; `move_cell` với `byUser: true`). Mọi thao tác của agent vẫn đi qua chat, với mode và review.
- Bản sao notebook Chrome trong VS Code (`vscode/src/mirror.ts`): một FileSystemProvider scheme `ainb-chrome` (`/<tabId>/<tên> (Colab).ainb`) đọc cell qua `get_cells`, một serializer kiểu `ainb-chrome-notebook` giữ id cell của trình duyệt trong metadata, và một NotebookController chạy cell bằng `run_cells` (chờ ngắn, phần còn lại theo dõi bằng poll). Mỗi giây VS Code đọc lại cell: thứ tự khác thì dựng lại cả notebook, nguồn khác thì chỉ thay cell mà user không đang sửa (văn bản còn bằng bản đã biết). Chiều ngược lại, chữ user gõ được gửi bằng `update_cell` sau 400 ms, còn thêm, xóa, di chuyển được `planPush` (`mirror-sync.ts`) biến thành các bước gửi theo thứ tự. Mọi lần gửi đi qua một hàng đợi; xong thì gọi `save()` (ghi file là no-op) để tài liệu không còn dấu chưa lưu. Tab Chrome đóng thì bản sao ngừng theo.
- **PanelCore** (`vscode/src/panel-core.ts`, không phụ thuộc API của VS Code) chọn notebook cho chat: notebook trong VS Code có id dương, notebook trong tab Chrome có id là id của tab, đổi dấu. Chat theo notebook vừa được đưa lên trước (editor notebook trong VS Code, hay tab Chrome); chuyển sang một editor không phải notebook thì giữ nguyên. Test trên trình duyệt (`extension/test/panel-harness.ts`) chạy đúng giao diện `ui` với `PanelCore` này trong một trang riêng.
- VS Code ngắt kết nối thì mọi chat đóng (chúng là của VS Code). Extension Chrome kết nối lại (service worker khởi động lại) thì chat về tab Chrome vẫn còn, và tab được báo lại sau `hello`.

## Luồng một tool call

```
agent ──MCP stdio──► `ainb mcp` (relay không trạng thái)
                       │ HTTP POST /mcp/call  (Bearer = token của chat)
                       ▼
                    bridge: Chat.runTool → callTool
                       │ 1. kiểm tra mode (protocol/modes.ts: decide)
                       │ 2. gửi NotebookOp
                       ▼  WS "notebook.op" {tabId, op}
                    tab Chrome: service worker ──chrome.tabs.sendMessage(frameId)──► content script
                                                                          │ window.postMessage
                                                                          ▼
                                                     page script (MAIN world): OpRunner → adapter
                    notebook VS Code: Extension Host ──► OpRunner → VSCodeNotebook
```

- **Vì sao relay stdio:** stdio là transport MCP duy nhất mà mọi agent ACP bắt buộc phải hỗ trợ. Relay không giữ trạng thái gì; bridge nhận ra chat nhờ token.
- **Vì sao kiểm tra mode trên từng lời gọi:** danh sách tool không đổi, nên agent không phải nạp lại. Đổi mode có hiệu lực từ lời gọi kế tiếp, và lời từ chối kèm lý do để agent nói lại cho user.
- **Review không chặn page:** op trả về `reviewId` ngay. Bridge chờ event `review_closed` trong khoảng `toolWaitMs` của agent. Quá hạn thì trả "đang chờ duyệt" và agent gọi `await_review`. Nhờ vậy Codex với giới hạn tool 60 giây vẫn dùng được.

## Agent (học từ openresearch_custom)

orx có lớp `Harness` riêng cho từng agent (khoảng 30k dòng Rust) vì mỗi agent nói một giao thức khác nhau. Ở đây cả bốn agent đều nói ACP: Claude Code và Codex qua adapter npm chính thức, Gemini qua `--acp`, OpenCode qua `opencode acp`. Vì vậy chỉ cần **một** client ACP (`bridge/src/agents/acp-agent.ts`) và **một registry** (`registry.ts`), trong đó mỗi agent chỉ là "chạy thế nào và nhận biết có hay không". Agent ACP khác thêm vào bằng `agents.json`.

Những gì giữ lại từ thiết kế orx:

- Transcript của bridge là bản ghi gốc; session riêng của agent chỉ là ngữ cảnh. Message được phát nguyên cả bản (gom mỗi 80ms), giao diện thay thế thay vì ghép delta.
- Playbook đi theo turn đầu của session. Một khối `<notebook-context>` ngắn (mode, cell đích, outline) đi theo mọi turn, nên đổi mode không cần restart agent.
- Khi đổi agent hoặc agent crash: agent mới nhận một bản tóm tắt có giới hạn (`instructions.ts: recap`).
- Yêu cầu xin quyền không bao giờ tự cho phép: Stop, đóng chat hay agent chết đều trả `cancelled`.
- Tin nhắn gửi lúc agent đang bận được xếp hàng; Stop xóa hàng đợi.

## Adapter notebook

**Colab** (`extension/src/page/colab.ts`). `colab.global.notebook` cung cấp cell (`getId/getType/getText/setText`, `getModel().toJson()` cho output) và `colabMcpToolsService.tools`, bộ tool agent Colab dùng cho Gemini, tìm theo `toolName` vì tên này không bị minify. Review dùng `cell.showInlineDiffTo(text)`: hàm này trả Promise\<boolean\> theo lựa chọn của user, và `getInlineDiff().accept()/reject()` để chat quyết thay.

**Kaggle / Jupyter** (`jupyter.ts`). Editor của Kaggle là Jupyter Notebook 7 (JupyterLab 4) trong iframe, config có `exposeAppInBrowser: true`, nên có `window.jupyterapp`. Adapter sửa cell qua `sharedModel` (`setSource/insertCell/deleteCell/moveCell`) và chạy cell bằng lệnh `notebook:run-cell`, lệnh này resolve khi cell chạy xong. Trạng thái đang chạy đọc từ prompt `[*]` vì bản 4.0 chưa có `executionState`. Review dùng thẻ diff riêng (`review-widget.ts`, shadow DOM).

**VS Code** (`vscode/src/notebook.ts`). Dùng `WorkspaceEdit` cho nội dung cell, `NotebookEdit` cho thêm/xóa cell và lệnh Notebook Editor để di chuyển hoặc chạy cell. `OpRunner` ghi thay đổi theo cell ID. Sidebar duyệt diff, chỉ tạo cell đề xuất khi người dùng bấm Apply. Thực thi ngoài cell dùng `kernels.getKernel(uri)` và `executeCode` của extension Jupyter. VS Code chỉ thay chỗ của giao diện: bridge đối xử với nó như một trình duyệt, agent vẫn làm việc trên máy của kernel (VM Colab qua kernel Colab, server Jupyter từ xa…) và file notebook được mirror ở đó, đồng bộ với Notebook Editor như với trang web. Adapter này không có `machineExec`, nên `machine_exec` (terminal, file) đi qua kernel. Kernel chạy ngay trên máy user, trong thư mục của notebook, thì file `.ipynb` ở đó là của user: theo luật chung, bridge không ghi đè mà dùng `<tên>.agent.ipynb`.

VS Code webview chỉ trao đổi message với Extension Host. Host kết nối WebSocket `/vscode` trên loopback và giữ token bên ngoài webview. VS Code giữ một id cho mỗi notebook đang mở và dùng URI của tài liệu làm khóa lưu chat; notebook trong tab Chrome giữ khóa do service worker tính.

## Chuẩn bị agent và quản lý launch command

Sidebar mở session ACP ngay khi notebook và agent đã được chọn. `session/new` cung cấp model/effort qua config options trước khi gửi prompt; thay đổi option được áp dụng xong trước khi bật Send. Mỗi tab vẫn dùng một session chat, kể cả lúc transcript còn trống.

`agents.save`, `agents.remove` và `agents.test` chạy qua liên kết của VS Code đã pairing. Launch command được tách thành executable và argv, không chạy qua shell. Agent tùy chỉnh được lưu nguyên các trường cấu hình đang có trong `agents.json`; các lần lưu cập nhật file bằng rename và phát `agents.changed` để sidebar cập nhật ngay. Test connection tạo session tạm, từ chối yêu cầu quyền, đọc options rồi dừng agent; không gửi prompt. Sửa/xóa agent đang chạy bị từ chối; session idle được đóng và transcript được giữ để mở lại bằng cấu hình mới.

## Ghép nối qua native messaging

`ainb install` (`bridge/src/native-host.ts`) viết một launcher (`.cmd` trên Windows, `.sh` trên macOS/Linux) gọi đúng bản Node và `cli.js native-host`, rồi đăng ký manifest `com.agent_in_notebook.bridge` cho từng trình duyệt: khóa registry `HKCU\…\NativeMessagingHosts` trên Windows, thư mục `NativeMessagingHosts` trong thư mục dữ liệu của trình duyệt trên macOS/Linux. Manifest chỉ cho phép extension có ID cố định (`EXTENSION_ID`, suy ra từ `key` trong manifest), cộng thêm các ID truyền qua `--extension-id`. Trên macOS/Linux, launcher giữ PATH lúc cài, vì trình duyệt mở từ giao diện đồ họa có PATH tối thiểu và sẽ không tìm thấy agent.

Service worker gọi `sendNativeMessage({type: "connect", start: false})` khi chưa biết token (hoặc token bị từ chối, hoặc user bấm biểu tượng), chỉ khi có notebook đang mở trong một tab và config không phải `manual`. Service worker khởi động lại thì hỏi các tab có thể chứa notebook (`discoverAll`) để báo lại cho bridge. Host đọc `config.json` và kiểm tra `/health`. Với yêu cầu của VS Code (không có `start: false`), nếu bridge chưa chạy thì host khởi động `serve --background --log bridge.log`, chờ tối đa 15 giây, rồi trả port và token. Trên Windows bridge được khởi động qua `Start-Process`, vì Node cho tiến trình con thừa kế mọi handle inheritable của cha, kể cả pipe của trình duyệt, và bridge sẽ giữ chúng suốt đời mình. Host được bundle thành chunk riêng (esbuild `splitting`), nên không phải nạp SDK MCP/ACP, vốn mất vài giây.

VS Code dùng chính launcher đó (`vscode/src/start-bridge.ts`): Extension Host chạy `<AINB_HOME>/native-host/ainb-native-host.cmd|.sh`, gửi một yêu cầu `connect` có khung độ dài như trình duyệt, nhận port và token, rồi đóng stdin để host thoát. Nhờ vậy plugin không cần bản bridge riêng và dùng đúng Node, CLI mà user đã `install`. Chưa có launcher thì plugin chỉ đọc `config.json` để nối vào một bridge đang chạy và nhắc chạy `ainb install`. Plugin chỉ bật bridge khi sidebar mở hoặc user bấm **Start the bridge**; sau mã 4001 (bridge bị dừng có chủ đích) nó không tự bật lại. Nút **⏻** trong sidebar gọi `POST /shutdown` với token.

Bridge là của VS Code. Host bật nó bằng `serve --background`, và bridge như vậy tự dừng khi không có VS Code nào nối vào trong 30 giây (`stopWithoutEditorMs`): VS Code đóng thì bridge đi theo, còn Reload Window nối lại kịp. Trình duyệt hỏi host bằng `{type:"connect", start:false}`: host chỉ trả port và token khi bridge đang chạy, không thì trả `notRunning`, và không bật bridge. Bridge chạy tay (`ainb serve`, `pnpm bridge`) không tự dừng.

Khi tắt có chủ đích (VS Code đóng, nút **⏻**, Ctrl+C, `ainb stop` → `POST /shutdown`), bridge đóng WebSocket với mã 4001. Extension Chrome khi đó chờ: nó thử nối lại bằng WebSocket với port và token đã biết (lùi dần tới 10 giây, cộng alarm 30 giây khi service worker ngủ), nên khi VS Code bật bridge lại thì notebook trong Chrome tự quay lại. Nó chỉ hỏi host khi chưa biết token. Lúc chờ, biểu tượng không có dấu **!**. Token bị từ chối thì extension hỏi lại host một lần, phòng trường hợp token đã bị reset. Config ghi tay vào `chrome.storage.local` (test, devtools) được đánh dấu `manual` để host không ghi đè. Extension không có giao diện: trạng thái kết nối hiện ở badge và tooltip của biểu tượng.

## Chat theo notebook

Mỗi notebook có một khóa ổn định (`protocol/identity.ts: notebookKey`), do service worker tính từ URL cấp cao nhất của tab (iframe Kaggle không biết mình là notebook nào) và, với Jupyter, đường dẫn tài liệu. Sidebar gửi khóa này trong `chat.open`; bridge giữ chat sống theo tab nhưng lưu transcript theo khóa (`bridge/src/store.ts`, ghi gộp mỗi giây và khi đóng chat). `chat.open` khôi phục transcript đã lưu và agent nhận tóm tắt như sau khi crash; những gì còn đang chờ trong bản lưu (prompt, review, tool) được chốt thành cancelled/discarded/failed. `notebook.attached` mang khóa khác khóa của chat thì chat bị lưu và đóng, để agent cũ không sửa nhầm notebook mới. `notebook.detached` chốt các review đang chờ thành `discarded`, vì trang đã mất chúng.

Kết quả đọc notebook (`Read` file notebook, `wait_for_cells`) có ngân sách tổng khoảng 60k ký tự; phần còn lại được nêu tên kèm `offset` để agent đọc tiếp (xem thêm mục Ngữ cảnh của agent).

## Hoàn tác

Trang notebook là nơi duy nhất biết chính xác một thay đổi đã áp dụng ra sao, nên `OpRunner` (`protocol/src/adapter.ts`) phát `change_applied` (`AppliedChange`: loại, cell, vị trí trước đó, nội dung trước/sau) cho mỗi thay đổi thật sự xảy ra: thao tác trực tiếp, hoặc review được chấp nhận (phát trước `review_closed`, kèm `reviewId`). Thao tác có `byUser` (hoàn tác, "Insert as cell") không được ghi.

Bridge (`Chat`) gắn thay đổi vào tin nhắn agent của lượt đó; review chấp nhận muộn đi theo tin nhắn chứa review. Nội dung đầy đủ nằm trong `journal` của chat (lưu cùng transcript ở `store.ts`); tin nhắn chỉ mang `changes: { count, undone }` để không phát lại nội dung lớn mỗi lần stream. `chat.undo` chạy ngược từng thay đổi: chỉ đụng vào cell còn đúng nội dung `after`, chèn lại cell đã xóa ở vị trí cũ (cell mới có id mới, các thay đổi cũ hơn trên cell đó đi theo id mới), và ghi một `<undo-note>` vào prompt kế tiếp cho agent.

## Ngữ cảnh của agent

Mọi thứ tool trả về nằm lại trong context của agent cho tới hết session, nên bridge rút gọn trước khi gửi:

- **Output** (`protocol/outputs.ts: outputsToText`): stream liền nhau của cùng một luồng được nối lại rồi áp ký tự carriage return như terminal (thanh tiến trình chỉ còn trạng thái cuối), dòng lặp liên tiếp gộp thành một dòng đếm (`squeezeRepeats`). Nếu vượt giới hạn (6.000 ký tự mỗi cell), lỗi được giữ tối đa một nửa chỗ, phần còn lại cho log; cả hai cắt theo dòng (`capLines`), giữ đầu và phần cuối dài hơn. Dòng tên lỗi và frame đầu (code của user) vì vậy không bị log đẩy mất.
- **Ngân sách**: một lần đọc tối đa ~60k ký tự (`READ_BUDGET`); một lần chạy ~30k (`RUN_BUDGET`): cell lỗi giữ đủ 6.000, các cell khác chia phần còn lại (tối thiểu 1.200), quá ngân sách thì chỉ báo trạng thái.
- **Phần bị cắt** được đánh dấu kèm gợi ý `read_output`: tool này lấy toàn bộ output của một cell trong trang và trả về theo trang (`start_line`, `line_count`) hoặc theo regex có ngữ cảnh.
- **Data URI** trong source (ảnh dán vào markdown) thành nhãn `[[ainb:data-N …]]` (`hideDataUris`). `Edit` so khớp trên văn bản agent đã thấy, và mọi thay đổi notebook qua `Edit`/`NotebookEdit`/`Write` đặt lại payload theo nhãn của cell cùng id (`restoreDataUris`) trước khi ghi.
- **Outline mỗi lượt** đọc `get_cells` với `summary: true`: trang chỉ gửi dòng đầu và số dòng của mỗi cell. Nếu outline giống lượt trước (cùng session), `<notebook-context>` chỉ ghi "unchanged".
- **Nén context**: playbook chỉ đi theo lượt đầu của session, nên khi agent tự nén context nó có thể mất luật. Bridge khai báo capability `session.compaction` khi `initialize`; agent hỗ trợ (Claude Code) gửi `compaction_update`, và khi status là `completed` thì lượt kế tiếp mang lại playbook cùng outline đầy đủ, kèm một notice trong transcript. Với agent không báo, `usage_update` tụt dưới 60% lần báo trước (từ ít nhất 20k token) cũng được coi là đã nén. Session mới xóa số liệu cũ để không bị nhầm.
- **Usage**: `usage_update` của ACP được lưu trong chat (`ChatSnapshot.usage`) và phát qua `chat.usage`; sidebar hiện mức đầy context.

## Chạy code ngoài cell

Op `execute` (`NotebookOp`) chạy code trên kernel mà không đụng tới notebook: JupyterLab/Kaggle dùng `kernel.requestExecute` với `store_history: false`, Colab dùng `kernel.execute(code, handler, {silent: false, storeHistory: false})`, trong đó `handler` có đủ các method Colab gọi trên handler của một lần thực thi (`onOutput` nhận dict output kiểu nbformat). Output được gom ở trang (`OutputCollector`: nối stream, xử lý `clear_output`, giữ tối đa khoảng 1 MB mỗi stream). Kernel đang bận thì op từ chối thay vì xếp hàng sau cell của user. Không có giới hạn thời gian: quá `waitMs` mà code chưa xong thì op trả `running` kèm `execId`, code vẫn chạy, `execute_wait` đợi tiếp (`Executions` trong `OpRunner`). `run_code` / `wait_for_code` dùng trực tiếp cơ chế này.

## Terminal trên máy của notebook

`bridge/src/notebook/shell.ts`. Trên VM, một daemon Python (khởi động bằng một đoạn code gửi qua `execute`, tách khỏi kernel bằng `start_new_session` rồi fork thêm một lần) giữ một `bash --noediting -i` trong pseudo-terminal 160×50. Mọi thứ terminal in ra được ghi nối vào `/tmp/ainb-shell-<uid>/<phiên>/out`; những gì ghi vào FIFO `in` được gõ vào terminal. Vì daemon không thuộc kernel, lệnh chạy bao lâu cũng được, kernel vẫn rảnh, và phiên sống qua lúc restart kernel.

Bridge chạm tới các file đó bằng những đoạn Python ngắn qua `execute` (`open`, `step`: ghi file lệnh, gõ vào FIFO, đọc log từ một offset; `close`). Log được đưa qua một emulator terminal (`@xterm/headless`, scrollback 10.000 dòng), nên agent đọc đúng những gì màn hình hiển thị. Lúc khởi động, bridge gõ một dòng thiết lập: `stty -echo` (lệnh bridge gõ không hiện lên màn hình), `PROMPT_COMMAND` và `PS1` in mã OSC 7770 `prompt;$?` mỗi khi về prompt (PS1 là dự phòng nếu lệnh của agent ghi đè `PROMPT_COMMAND`). Mỗi lệnh được ghi ra file `cmd-<id>` (một dòng terminal chỉ chứa được 4095 ký tự) rồi gõ ` __ainb_c="$(< file)"; rm -f file; printf OSC start;<id>; eval "$__ainb_c"`: chạy trong chính shell nên `cd`/`export` còn tác dụng; dấu cách ở đầu giữ dòng này khỏi history. Bridge biết lệnh bắt đầu và kết thúc ở đâu trên màn hình nhờ hai mã OSC, kể cả khi lệnh bị Ctrl+C (bash bỏ dở lệnh nhưng vẫn về prompt). Chữ agent gõ qua `shell_input` được bridge tự vẽ lên emulator, thay cho echo đã tắt.

Đợi lệnh là đọc log theo nhịp (100 ms tăng dần tới 1 s) cho tới khi có mã prompt hoặc hết thời gian của lượt gọi tool; lệnh chưa xong vẫn chạy, `shell_wait` chỉ báo phần mới (dòng đang được viết dở được báo lại). Trước mỗi thao tác, bridge đọc kịp log, nên lệnh đã xong giữa hai lượt gọi được báo kèm ở lượt sau. Bridge khởi động lại thì mở lại phiên đang sống và dựng lại màn hình từ 2 MB cuối của log; các mã OSC trong đó cho biết có lệnh đang chạy hay không. Chương trình dùng màn hình phụ (less, vim) được báo bằng nội dung màn hình. Phản hồi của terminal (vị trí con trỏ…) được gõ ngược lại như terminal thật.

Mỗi phiên một khóa riêng (`ShellSessions.exclusive`), không dùng khóa `run`, để một lệnh chạy lâu không chặn việc chạy cell. Các đoạn helper đi qua `machine_exec` (mục dưới), nên trên Kaggle/Jupyter cell đang chạy không ảnh hưởng. Khi phải đi qua kernel (Colab) mà kernel đang chạy cell, các đoạn đọc log bị từ chối (hoặc xếp hàng nếu cell vừa bắt đầu); bridge coi đó là tạm dừng đọc và báo cho agent. Policy: `Bash`, `shell_input`, `run_code` và việc ghi file trên VM là `execute` (chỉ Autonomous, Review bật thì hỏi trước, hộp xác nhận hiện đúng lệnh); `shell_interrupt` là `interrupt`; `shell_wait`, `wait_for_code` là `read`. Output vượt 10k ký tự được rút gọn, bản đầy đủ giữ trong `RecentRuns` để `read_output` đọc theo id `run-N`.

Không dùng terminal sẵn có của Colab/Kaggle làm phiên của agent: đó là xterm nối thẳng tới máy, không có API cho biết lệnh xong hay mã thoát, và mỗi nền tảng một kiểu. Phiên của agent là daemon ở trên; terminal của server chỉ là đường để tới daemon (mục dưới).

### Đường tới máy không qua kernel

Kernel chạy từng yêu cầu một, nên trong lúc một cell chạy, mọi đoạn helper phải xếp hàng sau nó (trang từ chối thay vì để agent treo). Op `machine_exec` dùng cho mọi helper (terminal, file) thay cho `execute`; trang chọn đường:

- **Terminal của Jupyter server** (Kaggle, Jupyter; `page/server-python.ts`): `serviceManager.terminals.startNew()` mở một terminal trên server; server tự phục vụ terminal, không qua kernel. Trang gõ vào đó một dòng thay shell bằng một vòng lặp Python (`exec python3 -u -c '…base64…'`, có dấu cách đầu để khỏi vào history). Vòng lặp chuyển terminal sang raw mode (không echo, không xử lý dòng, không giới hạn độ dài dòng), in `\x1eainb-ready`, rồi phục vụ: mỗi yêu cầu một dòng base64 của `{id, code}`, mỗi trả lời một dòng `\x1eainb-resp {id, out, error}`, với `out` là những gì code in ra. Helper giữ nguyên, chỉ đổi đường đi. Không mở được (server không có terminal, máy Windows, Python không lên trong 20 giây) thì trang dùng kernel và một phút sau mới thử lại; lỗi khác (quá giờ) được trả nguyên, vì code có thể đã chạy. Trang đóng terminal khi `pagehide`; nếu không kịp, vòng lặp tự thoát sau 15 phút không có yêu cầu và server bỏ terminal có tiến trình đã kết thúc. `NotebookInfo.serverTerminals` cho bridge biết đường này có, để notebook kernel R/Julia vẫn có terminal.
- **Kernel** (Colab, hoặc khi trên không được): như `execute`.

Thư mục làm việc và PATH vẫn hỏi kernel (`hello` qua `execute`, một lần), vì terminal của server làm việc ở thư mục gốc của server và có thể có PATH khác. Phiên terminal mới bắt đầu ở thư mục của kernel, với thư mục chứa Python của kernel đứng đầu PATH. Kernel không trả lời được thì hỏi qua terminal của server (với Jupyter: thư mục gốc cộng thư mục của notebook).

Colab có đường riêng không qua kernel: terminal của Colab nối websocket `/colab/tty` của runtime (`getKernel().getTerminalConnection()`). Có vẻ mỗi runtime chỉ một terminal, dùng chung với bảng Terminal của user, và giao thức chưa rõ, nên chưa dùng; cần dò trên runtime thật (`test/debug/colab-terminal-probe.mjs` chỉ đọc mã nguồn trang). Kế hoạch dùng SSH chính thức (`/colab/ssh`) cho Colab: [du-dinh-colab.md](du-dinh-colab.md).

Tool call song song: agent có thể gọi nhiều tool cùng lúc. `ToolContext.exclusive` xếp hàng theo hai khóa của chat: `edit` (đọc cell, tính nội dung mới, ghi, không xen kẽ, nên hai `Edit` trên một cell không ghi đè nhau) và `run` (Jupyter chạy cell qua "active cell"). Chờ review nằm ngoài khóa.

## Agent trên máy của notebook

Agent làm việc trên VM như trên máy của chính nó. MCP server `notebook` cấp `Bash` (terminal ở mục trên), `Read`, `Write`, `Edit`, `Glob`, `Grep`, và `NotebookEdit` cho file `.ipynb`; tên và tham số theo bộ tool của Claude Code để agent dùng theo thói quen. Với Claude Code, bridge tắt các tool gốc cùng tên trên máy user bằng `_meta.claudeCode.options.disallowedTools` khi tạo session (`AgentSpec.sessionMeta`). Các tool đọc/sửa cell kiểu cũ đã bỏ; chạy cell vẫn là `run_cells`, `run_all`, `wait_for_cells`.

**File trên VM** (`bridge/src/notebook/vmfs.ts`): một helper Python khác, gửi qua `machine_exec` như helper của terminal (`kernel.ts: helperCall`), chỉ làm thao tác file thô: `stat`, đọc theo dòng hoặc theo byte, ghi, `glob`, `grep` (regex Python, bỏ file nhị phân và thư mục ẩn, giới hạn 20 giây), `claim`. Mỗi lần đọc/ghi tối đa 512 KB, vì trang cắt một stream output ở khoảng 1 MB. Ghi là ghi ra file tạm rồi `os.replace` (giữ quyền của file cũ), kèm điều kiện: `stat` (size, mtime tính bằng ns, gửi dạng chuỗi vì vượt số thực) phải còn như lúc đọc, nếu không thì báo xung đột. `Edit` đọc cả file, thay chữ ở bridge, rồi ghi có điều kiện. Đường dẫn tương đối và `~` được bridge tính theo thư mục làm việc và thư mục home mà helper báo một lần (`hello`); khi kernel bận hoặc chưa có runtime thì dùng giá trị quen thuộc của nền tảng (`/content`, `/kaggle/working`).

**Notebook thành file** (`bridge/src/notebook/nbfile.ts`, `ipynb.ts`): file `<tên notebook>.ipynb` trong thư mục làm việc, nbformat 4.5, xếp như Jupyter lưu (khóa theo thứ tự chữ cái, thụt 1). Id của cell trong file là id của cell trong editor. Output được dựng lại từ dạng phẳng của trang (stream, `text/plain`, ảnh PNG/JPEG, lỗi); mỗi output text tối đa 20k ký tự trong file. Trước khi ghi lần đầu, helper `claim` tên file: đường dẫn trống, hoặc đã do bridge ghi (danh sách trong `/tmp/ainb-<uid>/files`), thì dùng được; nếu không (file notebook của chính Jupyter server) thì lấy `<tên>.agent.ipynb`.

- **Editor → file** (`syncOut`): trước khi agent đụng tới máy (`Bash`, `Glob`, `Grep`) và sau mỗi thay đổi notebook, bridge dựng lại nội dung từ `get_cells` và ghi nếu khác bản đã ghi, với điều kiện file chưa bị đổi từ lần ghi trước. Khác thì nhận thay đổi đó vào trước (như chiều ngược lại) rồi mới ghi.
- **File → editor** (`syncIn`): sau mỗi lệnh terminal, bridge `stat` file; nếu khác bản đã ghi thì đọc, parse, và so với bản đã ghi theo id (`applyCells`): cell đổi nội dung thì `update_cell`, cell mất thì `delete_cell`, cell không id (hoặc id lạ, hoặc đổi loại) thì `insert_cell` ngay sau cell đứng trước nó, thứ tự mới thì `move_cell`. Số lần di chuyển là ít nhất: các cell nằm trên dãy con tăng dài nhất giữ nguyên chỗ. Mỗi thao tác qua `decide()` của mode; Review bật thì mở review và agent nhận review id. Cell mà user đã sửa trên trình duyệt kể từ lần ghi trước thì giữ bản của user. Xong thì ghi lại file từ editor, nên phần bị từ chối biến khỏi file. File hỏng (không phải JSON notebook) thì được ghi lại từ editor và agent được báo. Output, `execution_count` và metadata trong file bị bỏ qua.
- **Đọc/sửa qua đường dẫn của file**: `Read`, `Edit`, `NotebookEdit`, `Write` trên đúng đường dẫn này không đi qua VM mà làm thẳng trên editor (`changeNotebook`: lấy cell hiện tại, tính cell đích, `applyCells`), nên dùng được khi kernel bận hay chưa có runtime, và kết quả review trả về ngay trong lượt gọi (chờ ngoài khóa `edit`). `Edit` so khớp trong nội dung từng cell như `Read` hiện ra, không phải trong JSON. Với file `.ipynb` khác trên VM, `Read` cũng hiện thành cell và `Edit`/`NotebookEdit` sửa theo cell, giữ output và metadata của cell được giữ.

Đổi tên notebook thì file cũ bị xóa và file mới được ghi ở lần đồng bộ sau. Đường dẫn file đi kèm `<notebook-context>` mỗi lượt và trong playbook.

## Stream và lưu transcript

Bridge không gửi lại nguyên tin nhắn mỗi 80ms mà gửi `chat.patch` (`MessagePatch`): text/thought tăng bằng `{i, at, append}`, part khác được thay cả khi JSON của nó đổi. `at` neo vị trí nối nên áp một patch hai lần không nhân đôi text (snapshot có thể đã chứa phần đó). `applyMessagePatch` trả `null` khi patch không khớp (mất sự kiện) và giao diện tải lại chat bằng `chat.get`. Hết lượt, bộ nhớ "đã gửi" bị xóa, nên thay đổi muộn (review được duyệt) đi dưới dạng part đầy đủ. Trong giao diện, `Message` được memo hóa, mỗi patch chỉ render lại tin nhắn đổi.

Transcript được lưu sau 2 giây yên lặng, bất đồng bộ (`ChatStore.saveAsync`); lúc đóng chat thì lưu đồng bộ. Mỗi lần lưu tăng "thế hệ" của khóa; bản ghi nền thấy có thế hệ mới hơn (lần lưu sau, lưu đồng bộ, hay `remove`) thì bỏ, nên không ghi đè dữ liệu mới hay làm sống lại transcript đã xóa.

## Ảnh trong kết quả tool

`normalizeIpynbOutput` giữ PNG/JPEG (base64, tối đa ~1,5 MB mỗi ảnh) trong `CellOutput.image`. Ở bridge, `Attachments` (`notebook/tools.ts`) gom ảnh cho một kết quả, tối đa 4 ảnh và 3 MB; trong text, chỗ của ảnh được thay bằng nhãn "image N attached". Relay stdio (`mcp-stdio.ts`) gửi chúng thành MCP image content sau phần text. Có gửi ảnh hay không do `AgentSpec.images` quyết định, nếu không đặt thì theo `promptCapabilities.image` agent khai báo khi `initialize`. `wait_for_cells` chỉ đọc trạng thái chạy khi chờ và lấy output một lần ở cuối, để không chuyển ảnh mỗi giây.

## Notebook only

`ChatSettings.notebookOnly` (mặc định bật). `Chat.onPermission` trả lời ngay bằng lựa chọn từ chối cho mọi yêu cầu quyền không thuộc tool notebook, và ghi một notice vào transcript. Tool notebook nhận ra qua tên (`isNotebookTool`) hoặc qua tool call cùng id đã được đánh dấu là notebook. `<notebook-context>` báo cho agent biết chế độ này.

## Bảo mật

Xem README. Hai điểm thiết kế đáng nhớ:

- WebSocket không bị CORS chặn, nên bridge kiểm tra cả Origin lẫn pairing token.
- Content script chỉ chuyển lên dữ liệu notebook; trang web không thể khiến bridge chạy agent.
