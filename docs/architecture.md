# Kiến trúc

Sáu package TypeScript trong một pnpm workspace:

| Package | Chạy ở đâu | Vai trò |
|---|---|---|
| `protocol` | mọi phía | Kiểu dữ liệu notebook, giao thức WS, `RpcPeer`, policy của mode (`decide`), diff theo dòng, chuẩn hóa output ipynb, `NotebookAdapter` và `OpRunner` |
| `bridge` | Node, trên máy user | Server WS/HTTP, quản lý chat, chạy agent qua ACP, tool notebook (MCP) |
| `ui` | webview VS Code | Giao diện chat Preact: transcript, Markdown/LaTeX, review, chọn notebook, agent và mode |
| `vscode` | VS Code Extension Host | Nơi duy nhất có chat. Adapter Notebook Editor, `PanelCore` (notebook nào đang được chat, notebook trong tab Chrome), chuyển request của sidebar tới bridge |
| `studio` | webview VS Code | Các màn Research (React) trên logic giao diện của OpenResearch, import từ mã nguồn của nó lúc build |
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

## Research: OpenResearch trong VS Code

Kiến trúc là một bridge với hai nhóm công cụ:
- **nhóm Notebook**: MCP `notebook` của bridge, dùng cho chat về notebook;
- **nhóm Research**: OpenResearch (`orx`), dùng cho chat Research, thử nghiệm và các lần chạy nền.

Chat Research là chat của chính OpenResearch: `orx up` giữ phiên chat, agent ACP, công cụ và skill `orx-*` của nó. Phía mình chỉ vẽ lại giao diện.

```
VS Code                                     bridge                     orx up --headless (127.0.0.1:cổng tự chọn)
 thanh Research, tab New Chat/Settings/      Orx (research/orx.ts):     API JSON + SSE /api/events
 Experiment, chat Research ở khung chat      tìm orx, bật/tắt,          SQLite orx.db, run engine
   fetch("/api/..."), EventSource  ──tunnel──► OrxTunnel (extension) ───────────────────► (HTTP cục bộ)
   research.status / configure     ──WS──────► theo dõi /api/events ──► research.run → VS Code
```

- **`bridge/src/research/orx.ts`** quản lý `orx up`:
  - Nếu đã có OpenResearch khỏe ở cổng 4791 thì dùng luôn, không tắt nó khi xong.
  - Nếu chưa có, bridge chạy `orx up --headless --port 0` và đọc dòng `orx up: dashboard on http://…` để biết cổng.
  - Bridge giữ một kết nối tới `/api/events`. Nhờ đó bản headless không tự tắt khi rảnh. Mỗi `run.updated` trên kết nối này được chuyển thành sự kiện `research.run` gửi VS Code.
  - Sự kiện đó mang theo `queueDetail` khi run đang `starting` nhưng còn xếp hàng ở nhà cung cấp (ví dụ Kaggle). Thanh trạng thái của VS Code đếm riêng các run này (`1 running · 1 queued`).
  - Khi `orx` báo cơ sở dữ liệu đang bị một bản khác giữ, lỗi được viết lại cho dễ hiểu.
  - `research.status {start}` trả trạng thái, kèm bật nếu được yêu cầu. `research.configure {orxPath?}` lưu đường dẫn vào `research.json` rồi khởi động lại.
  - `research.json` có thể có thêm `env` (ví dụ `ORX_DATA_DIR`, `ORX_CACHE_DIR`). Các biến này được đưa vào `orx up` do bridge chạy, để nó mở đúng thư mục dữ liệu của bản OpenResearch bạn tự chạy. Thư mục chứa `orx` cũng được thêm vào đầu `PATH`.
- **Tunnel** (`studio/src/tunnel.ts`, `vscode/src/orx-tunnel.ts`): webview không gọi thẳng được `orx`, vì khác origin và `orx` chỉ nhận lệnh ghi từ trang của chính nó.
  - Trong webview, `fetch` tới `/api/…` và `EventSource` được thay bằng bản gửi message cho extension.
  - Extension gọi `orx` như một tiến trình cục bộ, bỏ các header `origin`, `referer`, `sec-*`, và stream SSE về webview.
  - Phần logic của OpenResearch chạy nguyên vẹn, không biết mình đang ở trong VS Code.
- **`packages/studio`** là các màn tự vẽ theo giao diện VS Code: React, màu lấy từ biến `--vscode-*`.
  - Bên dưới là logic của OpenResearch, import từ `ui/src` của nó lúc build qua alias `@orx`: `createWorkspace`, các query của TanStack Query, `QueryEvents`, `api`, `useChatState`/`activePath` của transcript, `buildHistoryNodes`/`layoutLineage` của cây thử nghiệm, `runDisplay`, `HarnessLogo`, `renderMarkdown`.
  - `build.mjs` alias `react`, `react-dom` và `@tanstack/react-query` vào `node_modules` của OpenResearch, để chỉ có một bản của mỗi thư viện.
  - Typecheck sinh `tsconfig.gen.json` kế thừa cấu hình của OpenResearch.
- **Host** (`vscode/src/studio-host.ts`) phục vụ các màn này:
  - thanh bên trái (container `ainb`), về **project hiện tại**:
    - webview view `ainb.research` (tên "Notebooks", `studio/src/sidebar.tsx`): notebook chat của project (`notebookChats.list` của bridge; bấm thì `notebookChat.open`), rồi các notebook đang mở thuộc project khác (`notebooks.list`); máy tính toán ở Settings › Compute, mở bằng nút trên tiêu đề view (`ainb.openCompute`);
    - webview view `ainb.projectChats` (tên "Project Chats", `project.tsx: ProjectChats`): chat Research của project, side chat và sub-agent dưới chat cha (`delegateLineage`);
  - thanh bên phải có hai container: `ainb-chat` ("Agent in Notebook") chỉ chứa webview view `ainb.chat` (khung chat), hiện khi context key `ainb.mode != research` (ở chế độ Research container này biến mất); `ainb-project` ("Project") gồm:
    - webview view `ainb.project` ("Current Project"): thanh tên project (bấm để đổi project hoặc tạo project mới), và cây thử nghiệm khi chat đang chọn là chat Research;
    - hai tree view gốc (`vscode/src/folder-tree.ts`), đọc thẳng trên đĩa như Explorer (icon theo theme, mở bằng editor của VS Code, theo dõi thay đổi, menu chuột phải, kéo thả, F2/Delete): `ainb.code` là code mà chat Research đang mở làm việc trên đó: worktree riêng của chat (`profile-data/worktrees/<project>/<chat>`, tạo ở lượt đầu, trên nhánh thử nghiệm của chat), hỏi qua `/api/projects/{id}/code-tree?sessionId=` của OpenResearch; chưa có worktree hoặc không mở chat Research của project này thì là repo của project (`repoPath`). Tiêu đề ghi nhánh và đó là worktree của chat hay repo của project. Chat chưa có worktree thì cây xem lại sau mỗi 4 giây, khi đang hiện. Nút **Changes** trên tiêu đề (`vscode/src/changes.ts`) đổi cây thành danh sách phẳng như Source Control: các file chat đã đổi so với điểm tách khỏi nhánh gốc (`/api/chat/sessions/{id}/worktree`, kể cả file chưa track), có chữ và màu của git; bấm một file thì mở trình diff của VS Code, bên trái là bản ở commit gốc (scheme `ainb-base`, đọc bằng `git cat-file -p`, không dùng `git show` vì nó lỗi với đường dẫn dài trên Windows). `ainb.artifacts` là thư mục `artifactsDir`, nơi agent lưu báo cáo, hình, kết quả;
  - một tab editor cho mỗi màn (New Chat, Settings, Experiment, Research Chat; các thử nghiệm dùng chung một tab, các chat Research cũng vậy).

  **Hai chế độ** (`extension.ts: setSelected`, `selectChat`): context key `ainb.mode` là `research` khi chat đang chọn là chat Research, còn lại là `notebook`. Chọn một chat Research thì nó mở trong tab "Research Chat" ở giữa (`Studio.open({ view: "chat" })`) và thanh bên phải chuyển sang container `ainb-project` (container khung chat biến mất). Chọn một chat Notebook thì tab đó đóng (`Studio.closeChatTab`), notebook hiện ở giữa (file, hoặc mirror của tab Chrome qua `notebook.mirror`), và khung chat được focus. Một notebook lên trước trong editor khi đang ở chế độ Research cũng chuyển sang chế độ Notebook (`leaveResearch`) và đóng tab: mỗi lúc chỉ có một chế độ.

  Project hiện tại là project mở gần nhất (lưu trong `globalState`, phát qua sự kiện `project.current`). "Mở" là: hiện một chat Research của nó, hiện một chat Notebook có notebook thuộc nó, hoặc chọn nó ở thanh tên. Chưa mở project nào, hoặc project đó đã bị xoá, thì lấy project thay đổi gần nhất (`pickProject` trong `studio/src/messages.ts`, dùng chung cho webview và tree Artifacts).

  Các việc chỉ VS Code hoặc bridge làm được thì đi qua `host.request`: mở tab, chọn thư mục, danh sách notebook, chọn chat, agent của chat Notebook, kernel setup, log của lần chạy (terminal giả đọc `/api/runs/{id}/logs`). Bridge chưa kết nối thì host tự kết nối, trừ khi user vừa bấm tắt bridge.
- **Khung chat** (`ainb.chat`, ở thanh bên phải, chế độ Notebook) nạp cả `webview.js` (chat Notebook, Preact) lẫn `studio.js`. Hai bên dùng chung API của VS Code qua `window.__ainbVsCode`, và phân biệt message bằng trường `type`. Chọn một chat Research thì chat Notebook bị ẩn, còn chat Research được gắn vào một shadow root có `studio.css` riêng, để style của hai chat không lẫn vào nhau.
- **Kernel setup** (`bridge/src/notebook/setup.ts`, phương thức `notebook.setup`):
  - Script chạy ở phiên terminal `setup` trên máy notebook, cùng daemon với tool `Bash` của agent, nhưng không thuộc chat nào.
  - Bridge chờ tối đa khoảng 90 giây; script lâu hơn vẫn chạy tiếp trên máy.
  - Extension tự chạy script khi một notebook Colab/Kaggle trong Chrome có kernel đang chạy, nếu user đã bật tùy chọn này. Mỗi tab và notebook chỉ chạy một lần.

## Mentor: tự cài đặt ML, có người kèm

Mentor là người hướng dẫn **không code hộ**: bạn tự viết từng hàm, máy chấm quyết định đúng sai, AI chỉ hỏi dẫn, đưa gợi ý theo mức và hỏi vặn. Spec đầy đủ nằm trong kế hoạch "Spec: Mentor"; mục này tả cách nó được cài.

```
VS Code                                   bridge (bridge/src/mentor)                 Chrome: notebook Kaggle
 tab "Mentor" (mentor.js, Preact)  ─WS─►  Mentor: catalog, store, model
 thanh trạng thái 🔥 chuỗi · ★ rating      events.jsonl → fold → rating, chuỗi ngày
 Bắt đầu → chọn notebook (QuickPick) ─►   MentorPlaces (place.ts)  ──insert/delete_cell──► đề bài trong notebook
 bản sao notebook + khung chat     ─WS─►  Chat (mentor = MentorSession)  ──execute──► harness chấm bài trên máy Kaggle
   thanh 3 chặng, Chấm bài, Xin gợi ý     playbook <mentor>, tool mentor_*
```

- **Bài chạy trên notebook bạn tự mở trong Chrome** (Kaggle), không chạy trên máy bạn.
  - Bạn mở một notebook (mới hoặc cũ), extension Chrome nối nó với bridge như mọi notebook khác. Trên trang Mentor, bấm Bắt đầu: `mentor-host.ts` gọi `mentor.places` (các notebook đang nối, notebook nào đang chứa bài nào, bao nhiêu cell của bạn) và hiện QuickPick. Notebook đang chứa đúng bài dở này thì mở thẳng, không hỏi. Trang chủ ghi bài dở đang nằm ở notebook nào (`MentorToday.place`, bridge thêm vào từ các tab đang mở); notebook chứa bài mở hoặc đóng trong Chrome thì bridge phát `mentor.updated`. `mentor.start` không kèm `tabId` dùng notebook đang chứa bài dở, nếu có.
  - `MentorPlaces.start` (`place.ts`), tuần tự theo tab: đọc cell; notebook có cell không phải của Mentor thì cần `replace: true` (VS Code đã hỏi), bản cũ lưu thành `mentor/backups/<giờ> <tên>.ipynb`; notebook đang chứa bài khác thì phác thảo, dự đoán và lời giải của bạn được lưu vào `mentor/attempts/<attemptId>.json`. Rồi xóa mọi cell và chèn các cell của bài (`review: false, byUser: true`, nên không thành thay đổi của agent), có bài làm đã lưu thì đặt lại vào chỗ cũ, và ghi sự kiện `load`.
  - Cuộc trò chuyện đi theo bài: transcript của notebook được cất dưới khóa `mentor:<attemptId>` khi bài rời notebook và quay về khóa của notebook mới khi bài được chép lại. Chat trên tab bị đóng (snapshot `closed`), khung chat tự mở lại thành chat của bài mới.
  - Cell được nhận ra bằng dấu trong nội dung, không bằng id (id trên Kaggle do JupyterLab đặt): cell đề bài bắt đầu bằng `<!-- mentor: exercise <id> -->`, cell phác thảo/dự đoán bằng `<!-- mentor: sketch|predict -->`, cell lời giải có dòng `#| mentor: solution` (`notebook.ts: cellRole, exerciseIn, learnerWork, withWork`).
  - Kaggle đổi địa chỉ khi đổi tên notebook: `notebook.attached` với khóa mới trên một tab đang chứa bài thì `followRename` kiểm lại cell đề bài, ghi `load` cho khóa mới và chuyển transcript.
  - Sau đó VS Code mở bản sao của notebook (`notebook.mirror`) và focus khung chat. Máy Kaggle chưa bật thì Chấm bài báo "bấm nút nguồn trên Kaggle" (`kernelProblem`).
- **Mentor là một thuộc tính của chat notebook**, không phải loại chat mới.
  - `chat.open` trên một tab Chrome tra khóa notebook trong bảng notebook → bài (`Mentor.attemptIn`, gộp từ các sự kiện `load`). Notebook đang chứa một lượt làm bài thì chat mang `MentorSession`.
  - Chat mentor không có project: bỏ `refreshProject`, `refreshMachine`, không lưu `NotebookMeta`, không hiện trong `chats.list`. OpenResearch không bị khởi động.
- **Kho** ở `~/.agent-in-notebook/mentor/`:
  - `events.jsonl` chỉ ghi thêm, là nguồn sự thật: `start` (kèm `kind` và `scaffold`), `load` (bài được chép vào notebook có khóa nào), `stage`, `judge`, `hint`, `probe`, `misconception`, `recall`, `done`. Mỗi sự kiện mang ngày địa phương (ngày đổi lúc 4 giờ sáng).
  - `attempts/<id>.json`: bài làm dở của một bài đã rời notebook. `backups/`: notebook của bạn trước khi bị thay.
  - Sự kiện `start` cũ (đợt 1–2, bài là file `.ipynb` trên máy) còn trường `file`; vẫn được đọc, rating và chuỗi ngày giữ nguyên, làm tiếp thì đề được chép vào notebook Kaggle.
  - Mọi con số đều tính lại bằng phép gộp thuần `model.ts: fold/home`: Elo theo từng kỹ năng (bắt đầu 1000, K = 120/80/40 theo số bài đã làm), chuỗi ngày có ngày nghỉ phép, lịch nhiệt 16 tuần, trạng thái các sao, `pickToday` (làm tiếp → chẩn đoán → làm lại sau khi xem lời giải 3 ngày → biến thể của bài vừa vững → bài kế trên bản đồ).
- **Ôn ngắt quãng** (`kind: "review"`):
  - Tự làm đúng một bài (không xem lời giải) thì `scheduleReview` hẹn ôn sau 3 ngày. Ôn đạt với gợi ý tối đa mức 1 thì lần sau cách 10, rồi 30 ngày, rồi coi như đã thuộc; dựa vào gợi ý cao hơn hoặc xem lời giải thì quay về 3 ngày.
  - Lượt ôn bắt đầu ở chặng `build`, notebook chỉ có đề và một cell trống, không có Phòng công thức hay Bảo vệ. Chấm đạt là xong (`judged` gọi `setStage("done")`).
  - Điểm của lượt ôn chỉ tính phần code; gợi ý quá mức 1 thì điểm tối đa 0,3 (coi là quên). Rating đổi bằng một nửa K.
  - `pickWarmup` chọn bài ôn dở, hoặc bài quá hạn lâu nhất, thành thẻ "Khởi động" trên trang chủ. `starFade` làm sao mờ dần theo số ngày quá hạn (mờ hẳn sau 14 ngày); ôn xong là sáng lại.
- **Sổ lỗi sai**: `misconception` đưa một tag vào sổ, hẹn hỏi lại sau 2 ngày. Ở chặng `lab` của bài kế tiếp, `<mentor-state>` liệt kê tối đa 3 tag đến hạn, kèm câu hỏi và đáp án trong ngân hàng nếu tag đến từ đó. Mentor hỏi lại và chấm bằng `mentor_recall`: đúng thì hẹn sau 7 ngày, đúng 2 lần liền thì "đã vững"; sai thì quay về 2 ngày.
- **Khung code thưa dần** (`scaffoldFor`, `scaffoldStarter`): bài chẩn đoán và rating thấp (< 1250 ở kỹ năng yếu nhất của bài) có starter đầy đủ; 1250–1500 chỉ còn dòng `def`; từ 1500 là cell trống. Lượt ôn luôn trống.
- **Biến thể** (`variantOf`, `predict` trong `meta.json`): một bài nhỏ đổi một chi tiết của bài gốc, cùng ngôi sao, chỉ mở khi bài gốc đã vững. Chặng đầu là viết dự đoán vào cell `<!-- mentor: predict -->`; sau khi chấm đạt, mentor bắt so dự đoán với thực tế rồi mới hỏi vặn.
- **Nhận xét code** (`mentor.codeReview`): sau khi xong bài, mentor review lời giải như một đàn anh, được phép đưa đoạn code mẫu, không ảnh hưởng rating.
- **Bài soạn sẵn** ở `bridge/mentor-catalog/`:
  - `map.json`: các chòm sao, sao, vị trí và quan hệ "học trước".
  - `exercises/<id>/`: `meta.json` (kiểm bằng zod trong `catalog.ts`), `brief.md`, `lab.py` (Phòng công thức), `starter.py`, `reference.py`, `tests.py`, `probes.json` (câu hiểm kèm đáp án cho mentor), `mutants/*.py` (bản cố tình sai).
  - `notebook.ts: exerciseCells` dựng các cell: đề → Phòng công thức → Phác thảo → Bài làm (cell có dòng `#| mentor: solution`) → Thử nhanh. Lời giải và test không bao giờ nằm trong notebook.
  - `test/mentor-catalog.test.ts` chạy Python thật: lời giải chuẩn qua hết test, starter và mọi mutant đều trượt, không dòng nào của lời giải lọt vào notebook.
- **Chấm bài** (`judge.ts`, `Chat.judge`):
  - Lấy nguồn các cell lời giải, `exec` trong một dict mới (không dùng biến của kernel), chạy `test_*(user, ref)`, in một dòng `<<MENTOR {json} MENTOR>>` có nonce.
  - Chạy bằng op `execute` trong `withBusyJob`; quá 60 giây thì ngắt kernel.
  - Kết quả thành thẻ (đạt x/y, lỗi chạy, thiếu thư viện) và một lượt chat kèm khối `<mentor-verdict>` để mentor hỏi dẫn tiếp. Chấm đạt thì tự sang chặng Bảo vệ.
- **Ba chặng** (`session.ts`): `lab → build → defend → done`. Bridge từ chối sang Bảo vệ khi chưa chấm đạt, và từ chối Xong khi chưa đủ số câu hỏi vặn đã chấm. Xong thì ghi `done`, tính rating và hiện thẻ kết quả.
- **Agent** (`prompt.ts`, `tools.ts`):
  - Playbook `<mentor>` thay playbook gốc: không sửa cell của bạn, gợi ý đúng mức cho phép, hỏi câu hiểm từ ngân hàng câu hỏi.
  - Mỗi lượt có `<mentor-state>`: chặng, mức gợi ý, kết quả chấm, các cell bài làm nếu đã đổi.
  - Lời giải mẫu chỉ có trong khối `<hint-request level="4">`.
  - Danh sách công cụ cho phép (`MENTOR_CHAT_TOOLS`): `kernel_state`, `read_output`, `run_code`, `wait_for_code`, `interrupt_kernel`, cùng `mentor_read_cells`, `mentor_stage`, `mentor_probe_result`, `mentor_recall`, `mentor_misconception`. `/mcp/list` trả theo từng chat. Settings cố định (`MENTOR_SETTINGS`); khung chat ẩn bộ chọn Mode, Review, Notebook only và nút chèn code thành cell.
  - Danh sách này không phải hộp cát: `run_code` vẫn ghi được file, và agent không phải Claude giữ shell riêng.
- **Giao diện**:
  - Khung chat (`ui/src/mentor-bar.tsx`): thanh ba chặng, nút Chấm bài, Xin gợi ý n/4 (mức 4 hỏi xác nhận vì không được cộng rating), thẻ kết quả chấm và thẻ rating.
  - Trang chủ (`ui/src/mentor/home.tsx`, `constellation.ts`, `ui/mentor.css`): bản đồ chòm sao SVG trên nền trời đêm riêng, thẻ Khởi động (bài ôn), bài hôm nay kèm lịch ôn sắp tới, kỹ năng, chuỗi ngày và lịch nhiệt, sổ lỗi sai, tủ paper, một dòng nhắc "bài chạy trên notebook Kaggle bạn mở trong Chrome" kèm nút mở notebook Kaggle mới.
  - Chuyển động: sao nhấp nháy, số rating chạy từ giá trị cũ, sao vừa vững (hoặc vừa ôn xong) bùng sáng một lần. Những sao đã thấy được nhớ trong `localStorage` của webview. Mọi chuyển động tắt khi máy bật giảm chuyển động.
  - Host (`vscode/src/mentor-host.ts`): tab "Mentor" (lệnh `ainb.mentor.open`, nút ngôi sao trên tiêu đề khung chat), mục thanh trạng thái; bắt đầu bài thì chọn notebook (QuickPick, xác nhận khi thay cell của bạn), mở bản sao ở giữa và focus khung chat.
- **Paper** (đợt 3; thiết kế đầy đủ ở `docs/mentor-dot-3-4.md`):
  - Gói paper là một thư mục: `paper.json`, `given.py` (code cho sẵn chung), `exercises/` cùng định dạng bài thường. Paper mốc nằm ở `mentor-catalog/papers/` (khép một chòm, `closes`); paper bạn đưa vào nằm ở `~/.agent-in-notebook/mentor/papers/<id>/` kèm `source.md` (nội dung paper), `notes.md`, `drafts/` (bài đang soạn, không bao giờ được nạp) và `verify/` (biên bản kiểm chứng; bài chỉ được nạp khi biên bản khớp hash các file).
  - `catalog.ts` gộp bài soạn sẵn với bài của các paper (`papers.ts: loadPapers`). Mỗi paper thành một chòm ảo `paper:<id>`, mỗi bài một sao (`paperStars`, bố cục theo `uses`); `MentorConstellation.kind` tách bản đồ chính với tủ paper.
  - Bài nối tiếp nhau bằng `uses`: chấm đạt thì lời giải được lưu (`mentor/solutions/<id>.py`); bài sau có cell `#| mentor: carried` chứa code của bạn từ các bài trước, và máy chấm chạy code đó trước code mới (`Mentor.judgeContext`, `judgeCode(…, {before, beforeRef})`). Bài thiếu lời giải của bài trước thì không bắt đầu được.
  - Bài thí nghiệm (`role: "experiment"`, `judge: "kernel"`): chặng đầu là dự đoán; train xong, thẻ "chạy xong" có nút Chấm bài; test đo mô hình đang nằm trong kernel và báo con số (`t.report` → `MentorVerdict.metrics`, sự kiện `judge` mang `metrics`). Thí nghiệm không có ôn ngắt quãng.
  - Thư viện test `t` (`judge.ts: TEST_LIB`): `seed`, `close`, `shape`, `grad_close`, `load_into`, `report`. Định dạng bài: `mentor-catalog/PROTOCOL.md`.
  - Kiểm chứng (`verify.ts: verifyExercise`): lời giải chuẩn qua mọi test hai lần, starter và mọi bản sai trượt, Phòng công thức chạy được, chấm đủ nhanh, lời giải không lọt vào notebook. Bài PyTorch soạn sẵn được kiểm trên một notebook Kaggle bằng `ainb mentor verify [id…] [--tab N]` (route `POST /mentor/verify`, token ghép đôi, trả NDJSON); bài đạt ghi vào `mentor-catalog/verified.json`, và `mentor-catalog.test.ts` đòi mọi bài PyTorch có biên bản khớp hash.
  - Xưởng paper (`workshop.ts`): một notebook trong Chrome có cell đầu `<!-- mentor: paper <id> -->`, sự kiện `workshop` trong nhật ký (`state.workshops`). Chat xưởng (`WorkshopSession` role `plan`) có playbook `<mentor-paper>` và tool `paper_source`, `paper_plan`; `checkPlan` từ chối kế hoạch sai luật và kẹp độ khó quanh rating. Duyệt kế hoạch (`mentor.paper.approve`) chạy việc soạn bài như `busyJob` của chat xưởng: một `Chat` ẩn (role `author`, khóa `mentor-author:<id>`, `emit` rỗng) nhận từng `<author-task>`, ghi bài vào `drafts/` bằng `paper_exercise_write`, rồi `paper_exercise_check` kiểm chứng trên máy của xưởng; đạt thì bài lên tủ, hỏng sau 4 lần thì ghi vào `failed`.
  - Nội dung paper (`fetch.ts`): mã LaTeX gốc của arXiv (giải nén tar, ghép `\input`), rồi `orx paper --full`, rồi PDF rút chữ bằng `pypdf` trên máy của notebook.
  - Nhật ký thêm `void` (Báo bài sai: lượt làm không tính rating, không hẹn ôn), `paper` (duyệt kế hoạch là một ngày học), `workshop`. Bài do AI soạn đổi rating bằng một nửa. Trọng tâm (`profile.json: focus`, `mentor.focus`): bài hôm nay đi theo một paper hoặc một chòm, sau chẩn đoán và bài cần làm lại.
  - Giao diện: Tủ paper trên trang chủ (thẻ paper, chòm sao nhỏ, bảng con số, ghi chú, Mở xưởng, trọng tâm, Thêm paper qua link arXiv hoặc file PDF); thanh xưởng trong khung chat (Đọc paper · Kế hoạch · Soạn bài · Sẵn sàng, thẻ kế hoạch, Duyệt, Soạn tiếp, Dừng); bài thuộc paper có dòng "thành phần i/n · Eq." và nút Báo bài sai.
  - Khi việc soạn bài trục trặc (`workshop.ts: WorkshopHub.author`):
    - **Báo bài sai** với bài của paper bạn đưa vào: lý do được lưu trong `paper.json` (`reports`), xưởng hiện nút "Soạn lại bài này" (`mentor.paper.author { slug }`). Bài cũ được chép lại thành bản nháp (`seedDraft`), lý do của bạn nằm trong `<author-task kind="rewrite">`; chỉ bản qua kiểm chứng mới thay bài cũ. Thay xong: các lượt làm trên bản cũ bị hủy, lời giải đã lưu bị xóa (`Mentor.voidExercise`), và các bài dựng trên nó được kiểm chứng lại; bài nào trượt thì tự vào danh sách chờ soạn lại.
    - Lượt làm đã báo sai (`void`) không được làm tiếp và không tính, kể cả khi chưa xong (`model.ts`: `voided` đặt từ lúc `start`).
    - `mentor.paper.author { retry }` soạn lại cả những thành phần trước đó không soạn được ("Soạn lại phần hỏng").
    - Máy của notebook xưởng không trả lời (tắt, tab đóng): dừng soạn, không đánh dấu thành phần nào là hỏng, báo một dòng trong chat xưởng (`WorkshopHost.say`). Máy được thử trước khi bắt đầu, khi một lần kiểm chứng không chạy được, và trước khi kết luận một thành phần là hỏng.
    - Thành phần mà bài nó `uses` chưa soạn được thì không soạn (ghi "chờ bài …"), không tốn lượt AI.
    - Paper chỉ "sẵn sàng" khi mọi thành phần đã thành bài.
  - Điều kế hoạch quyết định thì AI soạn bài không đổi được (`writeDraft`): tên, kỹ năng, độ khó, số phút, `uses`, và với thí nghiệm là `metrics` kèm ngưỡng đạt (`target`). Máy chấm tự so con số `t.report` với ngưỡng (`judge.ts`), và kiểm chứng đòi đủ tên con số (`verify.ts`).
  - Code cho sẵn chung của paper (`given.py`) khóa lại khi đã có bài được kiểm chứng với nó.
  - Kế hoạch đổi sau khi duyệt (`setPlan`): khác bản đã duyệt thì chờ duyệt lại; thành phần đã thành bài giữ nguyên slug, tên, chữ ký hàm, `uses`; thí nghiệm đã soạn giữ nguyên con số và ngưỡng.
- **Giao thức nội dung** (`mentor-catalog/PROTOCOL.md`, phiên bản 1: `catalog.ts: CONTENT_PROTOCOL`): quy định cách thêm và định dạng chủ đề, sao, bài, test, câu hỏi, hint, để người hoặc AI thêm nội dung mà không sửa code.
  - **Gói chủ đề** `mentor-catalog/packs/<id>/` (`pack.json` + `exercises/`): thêm bài cho sao cũ, thêm sao vào chòm cũ, hoặc mang chòm sao riêng (`kind: "topic"`). `map.json` và `exercises/` là bộ gốc, không sửa khi thêm nội dung.
  - `catalog.ts: loadPacks` không bao giờ ném lỗi: thứ sai trong gói (file hỏng, id trùng, sao không tồn tại, bài PyTorch chưa kiểm trên Kaggle, `uses` vòng tròn) bị bỏ qua và ghi vào `catalog.problems`; bộ gốc vẫn kiểm chặt như cũ.
  - Sao không cần tọa độ: chòm riêng xếp cột theo `after` (`autoLayout`); sao thêm vào bản đồ chính tìm chỗ trống gần các sao đứng trước (`freeSpot`). Trang chủ vẽ mỗi chòm `topic` thành một bản đồ nhỏ dưới bản đồ chính (`home.tsx: Maps/TopicMap`, `constellation.ts: topicHeight`). Chòm có `daily: false` chỉ vào "Bài hôm nay" khi là trọng tâm (`model.ts: pickToday`).
  - `hints.json` (tùy chọn với bộ gốc, bắt buộc với gói): hint tác giả soạn cho mức 0–3. Mức 1–3 vào `<hint-request>` đúng mức người học xin (`prompt.ts: hintBlock`); câu hỏi mức 0 vào playbook, và câu gắn với một test (`"test"`) vào `<mentor-verdict>` khi test đó trượt đầu tiên (verdict mang `id` là tên hàm test). `probes.json` thêm `kind` và `stage` (tùy chọn).
  - Hash của bài (`exerciseHash`) bỏ qua `probes.json` và `hints.json`: thêm câu hỏi, hint không phải kiểm lại trên Kaggle.
  - `ainb mentor check [gói|bài…] [--all]` (`check-cli.ts`): luật tĩnh của giao thức (`lint.ts: lintExercise`), cú pháp Python, rồi `verifyExercise` bằng Python của máy; bài thiếu module (PyTorch) được báo là chờ `ainb mentor verify`. `ainb mentor reload` (`POST /mentor/reload`) cho Mentor đang chạy đọc lại catalog.
  - `AGENTS.md` ở gốc repo trỏ mọi coding agent (Codex, Claude Code…) tới giao thức khi được nhờ thêm nội dung.
- **Giao thức**: `WIRE_VERSION = 5`. Phương thức `mentor.home/places/start/judge/hint/stage/codeReview/report/focus`, `mentor.paper.add/open/get/approve/author/stopAuthoring/notes/archive`; sự kiện `chat.mentor`, `chat.workshop` và `mentor.updated`.

### Mentor bám vào phần còn lại ở đâu

Code riêng của Mentor (`bridge/src/mentor/`, `ui/src/mentor/`, `vscode/src/mentor-*`) gần như đứng một mình: từ lõi nó chỉ lấy kiểu của `@ainb/protocol`, danh sách tool (`notebook/tools.ts`), `toIpynb`, `loadConfig`, kiểu `ChatStore`. Chiều ngược lại mới là chỗ dễ vỡ: Mentor được **đan vào file của lõi**, nên ai sửa lõi cũng có thể đụng nó.

- **Chỗ đan** (sửa các file này thì chạy lại test Mentor: `pnpm --filter @ainb/bridge test mentor`):
  - `bridge/src/chat.ts`: `opts.mentor`/`workshop`, `tools()`, playbook và các khối prompt, `judge()`, `hint()`, thẻ chạy cell ("Hỏi mentor", "Chấm bài"), `isNotebookTool`. Mentor dùng nội bộ của `Chat`: `withBusyJob`, `exclusive`, `call`, `addCard`/`closeCard`, `send(text, {context})`.
  - `bridge/src/server.ts`: `mentorSession` trong `chat.open`, các handler `mentor.*`, `/mentor/reload`, `adoptRenamed`, lọc chat Mentor khỏi danh sách chat (`isMentorNotebook`).
  - `protocol/src/wire.ts`, `ui/src/app.tsx`, `vscode/src/extension.ts`, `panel-core.ts`, `bridge.ts`.
- **Thứ Mentor đọc theo tên hoặc theo câu chữ** (đổi bên lõi thì vẫn biên dịch được, chỉ có Mentor lặng lẽ kém đi), được ghim trong `bridge/test/mentor-contract.test.ts`:
  - Năm tool của lõi mà chat Mentor giữ lại (`KEPT` trong `mentor/tools.ts` và `mentor/workshop.ts`): `kernel_state`, `read_output`, `run_code`, `wait_for_code`, `interrupt_kernel`. Tool đổi tên là rơi khỏi danh sách.
  - Các câu báo lỗi của lõi mà Mentor giải thích cho người học (`mentor/judge.ts: kernelProblem`): kernel bận, máy Kaggle chưa bật, Colab chưa nối máy, trang không tới được, extension chưa nối.
  - Lệnh `orx paper --full -- <id>` (xem dưới).
- **Thứ trình biên dịch và test sẵn có đã canh**: năm op notebook (`get_cells`, `insert_cell`, `delete_cell`, `execute`, `interrupt`) qua kiểu `NotebookOp`; dạng khóa notebook (`protocol/test/identity.test.ts`; nhật ký Mentor lưu khóa này, đổi dạng khóa là các bài đang làm dở mất chỗ); chat thường không đổi vì Mentor (`mentor-chat.test.ts`: "leaves other notebooks' chats as they were").
- **OpenResearch**: Mentor chỉ gọi nó ở một chỗ, và chỗ đó tùy chọn: khi arXiv không có mã LaTeX thì thử `orx paper --full` (`mentor/fetch.ts: fetchArxiv`, gọi từ `server.ts`). Hỏng thì người học được bảo thêm paper bằng PDF. Chat Mentor không có project, không khởi động `orx up` (`mentor-chat.test.ts`: "never looks for OpenResearch").
- **Dữ liệu** của Mentor ở `~/.agent-in-notebook/mentor/`, lõi không dọn thư mục này.

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

## Theo dõi việc chạy cell

`RunWatcher` (`protocol/src/run-watcher.ts`) là cơ chế chung để biết một code cell vừa chạy xong, do user hay do agent. Mỗi `OpRunner` có một watcher: nhịp đầu chỉ ghi trạng thái hiện có, sau đó đọc mỗi giây (`pollMs`, `null` tắt timer cho test). Jupyter dùng `runStates()` đọc trực tiếp `running` và `executionCount`; VS Code đọc `document.getCells()` và `executionSummary`; Colab đi đường dự phòng `getCells({})` vì số thứ tự nằm trong `getModel().toJson()`. `OpRunner.dispose()` xóa timer khi notebook VS Code đóng hoặc panel bị dispose.

Một lần chạy được nhận ra khi `running` chuyển từ true sang false, hoặc `executionCount` đổi giữa hai nhịp mà watcher không thấy trạng thái running (cell chạy nhanh, hoặc cell user tự chạy trong VS Code). Watcher đọc lại cell kèm output rồi phát `NotebookEvent {type:"cell_run", run}`: vị trí, trạng thái ok/error/interrupted, số thứ tự, nguồn chạy, thời lượng nếu biết, dòng source đầu và lỗi cuối cùng. `KeyboardInterrupt` là interrupted. `agentRuns` đánh dấu cell ngay trước `runCell`; `OpRunner` gọi `tick()` ngay khi một run kết thúc (trừ timeout) để `cell_run` đi trước kết quả op trên cùng kênh. Lỗi adapter hoặc cell skipped không để sót nhãn agent.

Sự kiện đi qua content script và service worker nguyên vẹn tới `Chat.onNotebookEvent`. Chấm trạng thái và sự kiện chỉ có ích khi VS Code còn mở chat: chat được tạo theo notebook/tab và bridge tự tắt sau khi VS Code đóng.

Giới hạn đã biết:

- Sau khi kernel khởi động lại, một cell chạy nhanh hơn một nhịp và ra đúng số thứ tự cũ thì bị sót.
- Cell vừa được tạo và chạy xong trong cùng một nhịp thì bị sót.
- Chrome làm chậm timer của tab ẩn (có thể tới khoảng một lần/phút sau năm phút), nên sự kiện có thể tới trễ khoảng một phút; việc ẩn tab tự nó không làm mất sự kiện.
- Adapter VS Code chỉ biết `running` của các cell trong `pendingRuns` do `OpRunner` khởi động; cell user tự chạy được nhận qua `executionOrder` đổi. `executionSummary.timing` là tùy chọn trong API VS Code, chưa được kiểm chứng với kernel Jupyter/Colab thật; thiếu nó thì `lastDurationMs` không có, còn lại vẫn hoạt động.
- Chi phí `getCells({})` trên một notebook Colab lớn chưa được đo bằng DevTools. Nếu vượt 20 ms mỗi nhịp, đổi riêng Colab sang `{pollMs: 2000}` khi tạo `OpRunner` trong `extension/src/page/main.ts`; hiện giữ mặc định 1000 ms.

## Thẻ hành động

`ChatCard` (`protocol/src/wire.ts`) là mảnh transcript cho một việc vừa xảy ra và các hành động user có thể chọn. Bridge quyết định toàn bộ tiêu đề, chi tiết, tone, cell liên quan, nút, tiến độ và kết quả; UI chỉ vẽ `Part {type:"card"}` và gọi `chat.cardAction`. Card nằm trong một message `system`, nên đi qua `chat.patch` và được lưu như mọi mảnh khác. `WIRE_VERSION` là 4 để page script, bridge và VS Code cùng hiểu sự kiện/card mới.

`Chat.cards` chỉ giữ callback của các card đang mở trong phiên hiện tại. Nút Dismiss đóng tại chỗ; nút khác chạy callback tương ứng. Khi lưu/khôi phục transcript, `store.settle()` chuyển card còn `open` thành `stale`, bỏ nút vì callback không tồn tại sau restart. Card đã đóng hoặc action không thuộc card bị từ chối.

Với `cell_run` có lỗi khi agent rảnh, Chat thêm card lỗi với **Fix**, **Explain** và **Dismiss**. Mọi run sau của cùng cell (thành công, lỗi hay interrupted, kể cả trong lượt agent) làm card đang mở của cell đó thành `stale` với “Superseded by a later run”. Không tạo card cho interrupted hoặc khi một lượt agent đang chạy; tối đa năm card run đang mở.

Hàng đợi lượt chat mang `TurnInput {text, context?, targets?}`. Bấm Fix/Explain đóng card trước, đọc đúng cell kèm output rồi dựng `<cell-run>` bằng `renderCell(cell, true)`; nếu cell đã mất vẫn gửi tóm tắt từ `CellRun`. Khối này đứng ngay trước `<notebook-context>`, có yêu cầu sửa hoặc chỉ giải thích và chỉ dẫn trả lời theo ngôn ngữ user đang dùng. `targets` nhắm cell lỗi cho Edit cell khi user chưa ghim; cell đã ghim vẫn được ưu tiên như trước. Message user hiển thị câu Fix/Explain bằng tiếng Anh, còn agent nhận đủ cell và traceback mà không cần thêm một lượt Read.

Với cell thành công có `durationMs >= 60_000`, Chat dùng cùng `ChatCard` để mở thẻ “finished” và nút **Summarize result**. Lỗi dài vẫn dùng thẻ lỗi. Khi một run dài kết thúc ngoài lượt agent, bridge phát thêm `chat.run` mang `chatId`, `tabId`, `cardId`, `CellRun` và tên notebook. `vscode/src/bridge.ts` chuyển tiếp sự kiện này; Extension Host hiện thông báo với nút Show hoặc Summarize/Fix with agent, rồi gọi lại `chat.cardAction` khi cần. Cài đặt `ainb.notifyCellRuns` (mặc định bật) chỉ tắt thông báo, không tắt card. Không có lượt agent tự động sau khi cell xong: Summarize/Fix luôn do user bấm. Timer tab Chrome ẩn có thể làm sự kiện trễ tới khoảng một phút và mọi thông báo/card đều cần VS Code còn mở.

## Chuẩn bị agent và quản lý launch command

Sidebar mở session ACP ngay khi notebook và agent đã được chọn. `session/new` cung cấp model/effort qua config options trước khi gửi prompt; thay đổi option được áp dụng xong trước khi bật Send. Mỗi tab vẫn dùng một session chat, kể cả lúc transcript còn trống.

`agents.save`, `agents.remove` và `agents.test` chạy qua liên kết của VS Code đã pairing. Launch command được tách thành executable và argv, không chạy qua shell. Agent tùy chỉnh được lưu nguyên các trường cấu hình đang có trong `agents.json`; các lần lưu cập nhật file bằng rename và phát `agents.changed` để sidebar cập nhật ngay. Test connection tạo session tạm, từ chối yêu cầu quyền, đọc options rồi dừng agent; không gửi prompt. Sửa/xóa agent đang chạy bị từ chối; session idle được đóng và transcript được giữ để mở lại bằng cấu hình mới.

## Ghép nối qua native messaging

`ainb install` (`bridge/src/native-host.ts`) viết một launcher (`.cmd` trên Windows, `.sh` trên macOS/Linux) gọi đúng bản Node và `cli.js native-host`, rồi đăng ký manifest `com.agent_in_notebook.bridge` cho từng trình duyệt: khóa registry `HKCU\…\NativeMessagingHosts` trên Windows, thư mục `NativeMessagingHosts` trong thư mục dữ liệu của trình duyệt trên macOS/Linux. Manifest chỉ cho phép extension có ID cố định (`EXTENSION_ID`, suy ra từ `key` trong manifest), cộng thêm các ID truyền qua `--extension-id`. Trên macOS/Linux, launcher giữ PATH lúc cài, vì trình duyệt mở từ giao diện đồ họa có PATH tối thiểu và sẽ không tìm thấy agent.

Service worker gọi `sendNativeMessage({type: "connect", start: false})` khi chưa biết token (hoặc token bị từ chối, hoặc user bấm biểu tượng), chỉ khi có notebook đang mở trong một tab và config không phải `manual`. Service worker khởi động lại thì hỏi các tab có thể chứa notebook (`discoverAll`) để báo lại cho bridge. Host đọc `config.json` và kiểm tra `/health`. Với yêu cầu của VS Code (không có `start: false`), nếu bridge chưa chạy thì host khởi động `serve --background --log bridge.log`, chờ tối đa 15 giây, rồi trả port và token. Trên Windows bridge được khởi động qua `Start-Process`, vì Node cho tiến trình con thừa kế mọi handle inheritable của cha, kể cả pipe của trình duyệt, và bridge sẽ giữ chúng suốt đời mình. Host được bundle thành chunk riêng (esbuild `splitting`), nên không phải nạp SDK MCP/ACP, vốn mất vài giây.

VS Code dùng chính launcher đó (`vscode/src/start-bridge.ts`): Extension Host chạy `<AINB_HOME>/native-host/ainb-native-host.cmd|.sh`, gửi một yêu cầu `connect` có khung độ dài như trình duyệt, nhận port và token, rồi đóng stdin để host thoát. Nhờ vậy plugin không cần bản bridge riêng và dùng đúng Node, CLI mà user đã `install`. Chưa có launcher thì plugin chỉ đọc `config.json` để nối vào một bridge đang chạy và nhắc chạy `ainb install`. Plugin chỉ bật bridge khi sidebar mở hoặc user bấm **Start the bridge**; sau mã 4001 (bridge bị dừng có chủ đích) nó không tự bật lại. Nút **⏻** trong sidebar gọi `POST /shutdown` với token.

Bridge là của VS Code. Host bật nó bằng `serve --background`, và bridge như vậy tự dừng khi không có VS Code nào nối vào trong 30 giây (`stopWithoutEditorMs`): VS Code đóng thì bridge đi theo, còn Reload Window nối lại kịp. Trình duyệt hỏi host bằng `{type:"connect", start:false}`: host chỉ trả port và token khi bridge đang chạy, không thì trả `notRunning`, và không bật bridge. Bridge chạy tay (`ainb serve`, `pnpm bridge`) không tự dừng.

Khi tắt có chủ đích (VS Code đóng, nút **⏻**, Ctrl+C, `ainb stop` → `POST /shutdown`), bridge đóng WebSocket với mã 4001. Extension Chrome khi đó chờ: nó thử nối lại bằng WebSocket với port và token đã biết (lùi dần tới 10 giây, cộng alarm 30 giây khi service worker ngủ), nên khi VS Code bật bridge lại thì notebook trong Chrome tự quay lại. Nó chỉ hỏi host khi chưa biết token. Lúc chờ, biểu tượng không có dấu **!**. Token bị từ chối thì extension hỏi lại host một lần, phòng trường hợp token đã bị reset. Config ghi tay vào `chrome.storage.local` (test, devtools) được đánh dấu `manual` để host không ghi đè. Extension không có giao diện: trạng thái kết nối hiện ở badge và tooltip của biểu tượng.

## Notebook trong project

Thiết kế và lý do: [hop-nhat-openresearch.md](hop-nhat-openresearch.md). Tóm tắt phần đã làm:

- **Liên kết** notebook ↔ project nằm ở `chats/<hash>.meta.json` (`bridge/src/store.ts: NotebookMeta`), tách khỏi transcript, giữ 180 ngày (transcript 30 ngày). Đóng chat không xoá meta. Meta không có `projectId` thì notebook thuộc Scratch.
- **`bridge/src/research/projects.ts`** (`ResearchProjects`) gọi API HTTP của `orx up` mà bridge đang chạy, có timeout. OpenResearch chưa chạy thì nó bật `orx` ở nền và báo `OrxUnavailable` ngay, không bắt chat chờ. `ensureScratch()` tạo project Scratch một lần (`creationMode` folder hoặc blank, `githubSyncEnabled: false`), lưu id vào `research.json: scratchProjectId`; id cũ bị xoá thì tìm lại theo đường dẫn.
- **`bridge/src/research/links.ts`** (`ProjectLinks`):
  - `resolve` cho trạng thái `ready`, `pending`, `missing` (project đã bị xoá) hoặc `unavailable`;
  - `link` chuyển notebook sang project khác;
  - `list` liệt kê notebook chat của project (`chats.list`);
  - `brief` tạo tóm tắt project cho prompt (README/AGENTS.md/CLAUDE.md, danh sách artifacts; không có thử nghiệm hay lần chạy), cache 60 giây; ghi artifact qua bridge thì đánh dấu cache cũ. Chat Notebook không nghe `/api/events`.
- **Prompt** (`instructions.ts`): `<project-context>` (≤ 8000 ký tự) ở lượt đầu, sau khi agent tóm gọn ngữ cảnh, hoặc sau khi đổi project; các lượt khác không có gì về project. Không có OpenResearch thì có một dòng báo chưa có ngữ cảnh.
- **Project nhớ sẵn.** Mỗi lần OpenResearch trả lời về project, `ProjectLinks` lưu `meta.cache` (id, tên, `repoPath`, `githubUrl`, `artifactsDir`). Khi OpenResearch không trả lời, `Chat.requireProject` và `codeBlock` dùng bản này, nên đồng bộ code và shared artifacts vẫn chạy. Chỉ thiếu bản tóm tắt.
- **Code trên máy notebook** (`bridge/src/project/vmrepo.ts`: `CodeSync`; `project/worktree.ts`; `project/github.ts`). Agent sống trên VM:
  - **Trước mỗi lượt**, `Chat.codeBlock` gọi `CodeSync.ensure`, chạy tuần tự. Project không có `githubUrl`, kernel không phải Python, hoặc máy không phải POSIX thì agent được báo lý do trong `<project-code>`.
  - **Worktree và nhánh** (`ensureWorktree`): bridge tự `git worktree add -b notebook/<tên>-<hash6>` từ `HEAD` của `repoPath`, vào `<AINB_HOME>/worktrees/<project>/<keyHash>`. Commit bắt đầu và tên nhánh gốc được ghi vào `<git-dir>/ainb-base` (mục Changes so sánh với nó). Không có phiên OpenResearch nào phía sau. Rồi bridge kéo bản đã có trên GitHub (nếu có, fast-forward) và push.
  - **Token.** Token lấy từ `gh auth token` (CLI mà OpenResearch dùng), hoặc `AINB_GITHUB_TOKEN`, cache 5 phút. Git trên máy bạn dùng nó qua `-c http.https://github.com/.extraheader`, chỉ cho từng lệnh. Trên VM, bridge ghi nó bằng `vmfs.writeFile` vào `~/.ainb-git-credentials`, rồi đặt `credential.helper store --file`. Token không bao giờ nằm trong một lệnh. `redactTokens` che token trong kết quả mọi tool.
  - **Clone.** `runInSession` dùng một phiên terminal và một checkout dưới `~/.ainb-projects/` theo notebook, project, remote và nhánh. Trước khi dùng lại checkout, bridge kiểm tra thư mục Git, nhánh và URL của `origin`. Mất checkout thì clone lại.
  - **Sau mỗi lượt đã gọi agent** (`CodeSync.syncBack`), kể cả khi agent gặp lỗi: VM kiểm tra lại checkout, đưa file trên 50 MB chưa được track vào `.git/info/exclude`, rồi `git add -A`, commit và push bằng tên nhánh tường minh. Bridge theo dõi push chạy lâu trong nền, rồi `fetch` và `merge --ff-only` vào worktree.
  - **Autosave** (`Chat.scheduleAutosave`/`autosave`): một `cell_run` của user đánh dấu dirty và hẹn sync sau 10 phút khi đã có `CodePlace`, chỉ khi agent không bận. `SyncResult.ok` phân biệt lỗi/đang bận với không có thay đổi (`changed`). Chỉ kết quả `ok && changed` tạo system notice; lỗi im lặng, giữ dirty và thử lại sau một chu kỳ. Mốc đầu được đặt lúc lên lịch nên lần đầu không sync ngay. `lastSyncAt` chỉ phục vụ lịch, còn `lastSavedAt` chỉ cập nhật khi `ok`, nên thẻ máy mới không khẳng định đã lưu sau một lần thất bại. User chạy tiếp trong lúc sync không bị mất cờ dirty, và đóng chat xóa timer.
  - **Máy bị thay**: `stats.boot` được so với boot trong Chat/`NotebookMeta.machine` (ghi khi đổi hoặc sau 5 phút). Boot khác mở card kind `session` và phát `chat.session`; boot giống hoặc lần đọc đầu không tạo card. Metadata giữ `boot` và `seenAt`.
  - Khi máy đổi, Chat reset `NotebookMirror`, `ShellSessions`, registry `runInSession` cho code sync và kernel setup, đồng thời hủy job cũ. Điều này tránh cache path/claimed/last và màn hình terminal của máy cũ làm lượt Bash/clone đầu tiên trên máy mới lỗi. VS Code xóa `setupRan` theo tab; nếu `runOnAttach` bật thì tự bấm Restore qua `chat.cardAction`.
  - **Restore** phát `chat.session {restore:true}` để VS Code chạy kernel setup script của project và ghi log OutputChannel, rồi gọi `chat.sessionStep(setup|code)`. Nếu setup vẫn chạy (kể cả lần Try again bị từ chối vì “previous setup is still running”), chuỗi dừng trước `ensureCode` và card giữ Try again; không clone/rerun khi setup chưa xong. Lỗi setup/code được giữ trong card khi hiển thị danh sách cell, không bị dòng “N cells” ghi đè. Bridge dùng lại `ensureCode`/`CodeSync.ensure` (cùng worktree, nhánh và token), đọc code cell có execution count và trả IDs tăng dần cho nút **Run them again**. Lỗi đọc cell cũng trở về nhánh Try again thay vì kẹt card không nút.
  - Rerun dùng `busyJob` và `runCellsInOrder`: mỗi `run_cells` một id, chờ 50 giây rồi poll `get_cells(includeOutputs)` mỗi 2 giây tới khi xong, dừng ở error/skipped/cell mất, cancel gọi interrupt. Tin gửi giữa job xếp hàng và chỉ chạy sau finally. Cell lỗi vẫn tạo thẻ Fix, còn thẻ finished/notification cho cell dài bị chặn trong job.
  - Giới hạn được nói rõ trong card/README: biến không được khôi phục, file ngoài code và file trên 50 MB không được lưu, phần việc giữa hai lần autosave (tối đa khoảng 10 phút) có thể mất. Việc cho user khai báo thêm thư mục checkpoint/output ngoài code để chép vào shared artifacts là hướng mở rộng sau, chưa làm.
  - `ChatProject.worktree` báo đường dẫn worktree cho VS Code. Mục **Chat Worktree** (`folder-tree.ts`, `studio.chatWorktreeOf`) hiện nó; Changes tính bằng git trên máy (`changes.ts: localChanges`, so với `ainb-base`). Chat Research vẫn dùng worktree và `/api/chat/sessions/{id}/worktree` của OpenResearch.
- **Tool** (`bridge/src/project/tools.ts`) là MCP server thứ hai: relay `ainb mcp` với `AINB_MCP_SERVER=project` gọi `/mcp/project/list|call`. Chúng dùng chung `ToolDef`, `check` và policy với tool notebook. Action `save` trong `protocol/modes.ts`: Edit cell thì cấm; Write/Autonomous thì cho; Review bật thì hỏi trước.
  - `artifact_list`, `artifact_read`, `artifact_write` làm việc thẳng trên `artifactsDir` (không qua OpenResearch), qua `realpath`. Chúng từ chối symlink và đường đi ra ngoài, và ghi nguyên tử. `artifact_write` nhận `content` hoặc `from_vm` (đọc bằng `vmfs.readFile`, tối đa 50 MB); `artifact_read` có `to_vm` (ghi bằng `vmfs.writeFile`, action `execute`). Ghi đè file mà chat không tự ghi thì luôn hỏi trước.
  - `save_notebook` ghi notebook kèm output vào `artifacts/notebooks/`.
  - `paper_search` và `paper_read` chạy `orx discover <nguồn> … -- <câu>` và `orx paper [--full] -- <id>` trên máy người dùng (`Orx.cli`: cùng `locateOrx` và `orxEnv` với `orx up`, nhưng không cần server). Chúng định dạng lại JSON kết quả và chia toàn văn thành trang 40 000 ký tự. Lỗi của orx (chưa cài, nguồn bị tắt, mất mạng) được đưa nguyên cho agent.
  - **`/lit-review`**: tin nhắn có `/lit-review` thì `Chat.buildPrompt` thêm khối `<lit-review>` (`instructions.ts: litReview`), bản rút gọn của skill `orx-lit-review` cho hai tool trên. Playbook (luật 9) dặn agent dùng chúng cho câu hỏi khoa học ngay cả khi không gõ lệnh.
- **RPC mới**: `notebook.link`, `notebook.project`, `chats.list`, `chat.saveNotebook`; `chat.open` nhận `projectId`; `ChatSnapshot.project`.
- **VS Code**:
  - `extension.ts` theo dõi `project` trong snapshot để thanh bên phải theo chat Notebook. Nó cũng xử lý `project.move` (quick pick) và `project.show`, gắn notebook Kaggle mở từ launcher vào project đang hiện (trong 15 phút), và chạy kernel setup của project.
  - `studio-host.ts` phục vụ `projects.list`, `notebookChats.list`, `notebookChat.open`, `agents.logins` (`/api/harnesses`) và `agents.fromResearch` (`/api/harnesses/acp`).
- **Test** không bao giờ chạm OpenResearch thật: `test/fixtures/fake-orx-api.ts` giả API và SSE, còn các test cũ dùng `NO_ORX`.
- Phần OpenResearch (submodule) không bị sửa.

## Verify and save

`chat.verifyNotebook` (`Chat.verifyAndSave`) kiểm tra project, kernel Python idle và danh sách code cell trước khi mở card kind `verify`, đồng thời chụp `id + full source` của từng cell. Nút Verify chạy `execute("%reset -f")` rồi `runCellsInOrder` theo vị trí cell trong notebook, với tiến độ và nút Stop. `busyJob` dùng chung với Restore nên tin nhắn giữa chừng được xếp hàng; cancel gọi interrupt. RunWatcher vẫn phát `cell_run` như agent, nên cell lỗi tạo thẻ Fix, còn thẻ finished/notification cho cell dài bị chặn trong job.

Chỉ khi mọi cell qua và `AbortSignal` chưa bị hủy, bridge mới đọc lại `id + full source` để đối chiếu trước khi gọi `saveNotebook` với `user.notebookKey`. Notebook thêm/xóa/đổi thứ tự/sửa source trong lúc verify thì không lưu (“The notebook changed during verification”). Stop trước lần đọc cuối hoặc ngay trong lần đọc đó cũng không lưu; khi đã bắt đầu ghi artifact, nút Stop được gỡ và card ghi “Saving…”, tránh báo Stop nhưng vẫn tạo file. Kết quả thành công ghi “Verified: N cells ran from a clean state. Saved to …”. Reset lỗi, cell lỗi hoặc save lỗi đều đóng card với “Nothing was saved”.

“Clean state” chỉ là `%reset -f`, **không phải kernel restart**: module đã import còn trong cache, thư viện và file còn nguyên. Cách này dùng op `execute` hiện có và chỉ hỗ trợ Python/IPython; cần kiểm tra trên Colab/Kaggle/Jupyter thật vì không có một API restart kernel chung.

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
- **Run state**: `RunWatcher` giữ `textHash` (FNV-1a 32 bit + độ dài) của source lúc cell **bắt đầu chạy** và hash last-seen cho run nhanh không quan sát được `running`. `OpRunner.get_cells` so source đầy đủ với hash lần chạy đó và thêm `stale` trước khi `summarizeCell` cắt source; `renderCell` ghi “STALE (edited since it last ran)”. Vì vậy sửa source trong lúc cell chạy, hoặc chạy nhanh A rồi sửa B trước cùng tick, vẫn báo output thuộc source cũ. `runState` tóm tắt cell đang chạy, cell stale, cặp execution count đảo thứ tự đầu tiên và cell chưa chạy phía trên cell có count lớn nhất. Chỉ gửi các dòng này khi chúng đổi hoặc khi playbook được gửi lại; execution count không nằm trong chuỗi outline nên chỉ chạy cell không làm outline gửi lại.
- **Hoạt động của user**: tối đa 20 `CellRun` gần nhất do user được gom trong `<notebook-activity>` ở lượt kế tiếp rồi xóa, kể cả run xảy ra trong lượt agent. Khi kernel từ disconnected/unknown về idle, một ghi chú cùng khối báo rằng biến từ các run trước có thể đã mất.

## Trạng thái máy và kernel

`vmfs` có op `stats` chỉ dùng thư viện chuẩn Python: `/proc/meminfo` (ưu tiên giới hạn cgroup nếu có), `shutil.disk_usage`, `nvidia-smi` với timeout 3 giây và Linux boot id. Mọi phần đọc đều có fallback riêng; thiếu GPU hay một nguồn không làm mất các trường khác. Việc số cgroup khớp giao diện Colab/Kaggle và việc kernel Jupyter/Colab trong VS Code điền `executionSummary.timing` vẫn cần kiểm chứng trên máy thật.

`Chat.refreshMachine` gọi `machine_exec`, tối đa một lần mỗi 20 giây và chỉ một request đang chạy. Nó chạy khi mở chat, sau `cell_run`, khi kernel nối lại và trước mỗi prompt (Promise.race 1,5 giây nên không chậm lượt hơn mức đó). Kernel bận, mất kết nối, không phải Python hoặc lỗi khác đều bị nuốt và giữ số cũ. Thành công thì cập nhật `ChatSnapshot.machine` và phát `chat.machine`; `machineLine` đưa một dòng Machine vào prompt mỗi lượt, kèm LOW MEMORY dưới 10% RAM khả dụng, DISK NEARLY FULL dưới 5% disk trống và GPU MEMORY NEARLY FULL trên 90% VRAM. Header UI hiện tối đa RAM/GPU/Disk với cùng ngưỡng, tooltip số tuyệt đối và giờ đọc.

Cùng nhịp watcher, `OpRunner` đọc `adapter.info().kernel` (prime ngay constructor để không nuốt transition trước tick đầu); sau đó phát `kernel_changed` khi giá trị đổi. Background cập nhật `tabs.info`; bridge cập nhật `browserNotebooks` và phát `browser.notebook` để chấm kernel và autoSetup chạy đúng lúc runtime nối lại, đồng thời chuyển sự kiện cho Chat. Chat giữ `lastKernel` riêng vì `notebook.attached` có thể ghi đè info trước event; VS Code coi `restarting/autorestarting` là `disconnected`, nên chuỗi restart → idle tạo được ghi chú biến có thể mất. Khi reconnect, `refreshMachine(true)` bỏ throttle 20 giây và, nếu lần đọc cũ còn dở, xếp một lần đọc mới ngay sau đó. `setupRan` vẫn chống chạy setup lặp như trước.

Tool `kernel_state` (`TOOLS`, policy `read` nên được phép ở mọi mode) chỉ dùng `kernelExec` → op `execute`, không dùng `machineExec`: helper chạy trong namespace riêng nhưng đọc `get_ipython().user_ns` của đúng kernel notebook. Nó bỏ tên nội bộ, module, hàm và class; lấy type, shape hoặc len, kích thước (`nbytes`, pandas, torch rồi `sys.getsizeof`) và device khi có, mọi truy cập thuộc tính đều bọc try và không gọi `repr()` object. Kết quả lớn nhất đứng trước, giới hạn/lọc regex do agent chọn. Chỉ Python, kernel bận trả lỗi rõ ràng.

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
