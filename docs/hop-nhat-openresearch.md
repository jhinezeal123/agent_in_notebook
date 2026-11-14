# Hợp nhất Agent in Notebook vào OpenResearch

Trạng thái: đã làm, với hai thay đổi so với thiết kế dưới đây (xem README và docs/architecture.md):
- Code của project nằm trên máy notebook: mỗi notebook chat có nhánh và worktree riêng, máy notebook clone nhánh đó bằng token GitHub của OpenResearch, và bridge kéo về sau mỗi lượt. Project phải có GitHub.
- Bỏ tính năng handoff (`handoff_to_research`, nút "Hand off to Research").
- Bridge tự tạo worktree (không qua phiên OpenResearch). Tool của notebook chat rút gọn còn `artifact_list/read/write`, `save_notebook`, `run_result`; bỏ đọc code (code đã ở trên VM), `paper_search`, `push_to_vm`, nút "Open in notebook copilot" và gợi ý từ requirements.txt. Hai mục bên phải đổi tên thành "Chat Worktree" và "Shared Artifacts".
- Thêm lại tìm bài báo, bản đầy đủ: `paper_search` và `paper_read` gọi `orx discover` và `orx paper` trên máy người dùng, và lệnh `/lit-review` trong chat Notebook theo quy trình `orx-lit-review` của OpenResearch.

## Bối cảnh

Notebook chat (AINB) hiện chưa biết gì về project:

- cwd là `~/.agent-in-notebook/workspaces/<hash>`;
- prompt không có thông tin project;
- `chat.open` không có trường project;
- chọn notebook chat không đổi project hiện tại.

Mục tiêu là dùng AINB ngay trong một project của OpenResearch để tận dụng ngữ cảnh, tài liệu và tài nguyên chung. Một project có hai cách làm việc:

- **OpenResearch**: tự động hoàn toàn (AI lái).
- **AINB**: copilot trên notebook (bạn lái, AI phụ).

Đã chọn:

- AINB giữ notebook chat: bridge chạy agent và lưu lịch sử.
- Chat được gắn vào project và mượn ngữ cảnh qua HTTP API của OpenResearch.
- Mọi notebook chat thuộc một project; chat lẻ vào project "Scratch".
- Giữ submodule.
- OpenResearch không cần sửa gì cho tới giai đoạn 6. Mọi thứ dùng route có sẵn và chạy trong bridge, nên không đụng upstream, cũng không cần `downstream/`.

---

## Sơ đồ 1: Kiến trúc sau khi hợp nhất

```
                           VS Code — nơi bạn làm việc
┌──────────────────────────────────────────────────────────────────────┐
│ Research Project ▸ Project X                                         │
│   ├─ Research chats   (OpenResearch · tự động)                       │
│   ├─ Notebook chats   (AINB · copilot)              ◄── MỚI          │
│   └─ Experiments · Code · Artifacts   (đi theo chat đang chọn) ◄── MỚI│
│ Khung chat notebook: [● Project X ▾ Move…]  [Save to project]        │
│                      [Hand off to Research]                 ◄── MỚI  │
└──────────────┬────────────────────────────────────┬──────────────────┘
               │ WebSocket (pairing token)          │ /api/* qua tunnel
┌──────────────▼──────────────────────┐   ┌─────────▼────────────────────────┐
│ AINB bridge (Node, 127.0.0.1)       │   │ OpenResearch  orx up :4791       │
│                                     │   │                                  │
│ Notebook chat ─ACP─► Claude/Codex…  │   │ Project X = repo git             │
│  cwd: workspace riêng của chat      │HTTP│  experiments (nhánh orx/*)      │
│  MCP "notebook" ─► máy notebook     ├──►│  runs · log · result_markdown    │
│  MCP "project"  ─► project   ◄─MỚI  │   │  artifacts/  (files/<slug>/)     │
│  <project-context> trong prompt◄MỚI │◄──┤  paper · Kaggle pool · harnesses │
│                                     │SSE │ Research chats (agent tự chạy)  │
│ chats/<hash>.json      (lịch sử)    │/api/events                           │
│ chats/<hash>.meta.json (projectId)◄MỚI  └──────────────▲───────────────────┘
│ research.json          (scratchId)◄MỚI                 │ ghi file thẳng
│                                     ├──────────────────┘ vào artifacts/
└──────────────┬──────────────────────┘   (chỉ artifacts, không bao giờ vào repo)
               │ WebSocket
┌──────────────▼──────────────────────┐
│ Chrome extension · VS Code notebook │
│ Colab · Kaggle · Jupyter (VM)       │
└─────────────────────────────────────┘
```

## Sơ đồ 2: Hai chế độ trên cùng một project

```
                  ┌───────────────── PROJECT X ─────────────────┐
                  │ repo · paper · experiments · runs · artifacts│
                  └──────▲───────────────────────────────▲──────┘
                         │ đọc / ghi artifacts            │ đọc / ghi / chạy
     COPILOT (AINB)      │                                │     TỰ ĐỘNG (OpenResearch)
     bạn lái, AI phụ ────┘                                └──── AI lái, bạn duyệt
     notebook Colab/Kaggle                                      nhánh git, run nền
     khám phá dữ liệu, thử nhanh                                thí nghiệm có hệ thống
            │                                                          ▲
            ├── handoff_to_research (ý tưởng + notebook đã lưu) ───────┘
            ◄── kết quả run mới hiện trong <project-update> ───────────
```

## Sơ đồ 3: Ngữ cảnh, tài liệu và tài nguyên chảy ra sao

```
PROJECT X (OpenResearch)                             NOTEBOOK CHAT (AINB)
┌──────────────────────────────────────┐             ┌─────────────────────────────┐
│ README · AGENTS.md · CLAUDE.md (đầu) │─tóm tắt────►│ <project-context>           │
│ experiments + mô tả + trạng thái     │─tóm tắt────►│   lượt đầu + sau compact    │
│ 5 run mới nhất + kết quả             │─thay đổi───►│ <project-update>  khi đổi   │
│ code (mọi nhánh, worktree)           │─đọc────────►│ project_read / files / grep │
│ log run, metrics                     │─đọc────────►│ project_run_log (phân trang)│
│ paper · alphaXiv                     │─tìm────────►│ paper_search                │
│ artifacts/notebooks/*.ipynb          │◄─lưu────────│ save_notebook               │
│ artifacts/notes/*.md                 │◄─ghi────────│ write_note                  │
│ code project                         │─chép lên VM►│ push_to_vm                  │
│ Research chat mới                    │◄─giao việc──│ handoff_to_research         │
│ Kaggle pool · Kernel Env theo project│─dùng chung─►│ mở notebook, setup VM       │
└──────────────────────────────────────┘             └─────────────────────────────┘
```

Research agent thấy công việc ở notebook qua `artifacts/`, vì thư mục này có trong playbook của nó.

## Sơ đồ 4: Một lượt chat

```
Bạn      Chat UI        Bridge                         OpenResearch      Agent        VM notebook
 │ gửi    │               │                                 │              │              │
 │───────►│ chat.send ───►│ project của notebook (meta)     │              │              │
 │        │               │ cache bẩn? (do /api/events) ───►│ GET project, │              │
 │        │               │◄──── digest ────────────────────│ exp, runs,   │              │
 │        │               │ so với digest đã gửi            │ files        │              │
 │        │               │ prompt = rules + <project-…>    │              │              │
 │        │               │        + <notebook-context> + tin ────────────►│              │
 │        │               │◄── mcp__project__project_read ─────────────────│              │
 │        │               │ GET /file?ref=… ───────────────►│              │              │
 │        │               │◄── mcp__notebook__run_cells ───────────────────│              │
 │        │               │ kiểm mode/Review → Chrome ─────────────────────────────────────►│
```

## Sơ đồ 5: Lộ trình (mỗi giai đoạn ship riêng, dùng được ngay)

```
 GĐ1 Gắn project ──► GĐ2 Ngữ cảnh ──► GĐ3 Tool đọc ──► GĐ4 Ghi ──► GĐ5 Chuyển chế độ ──► GĐ6 Tài nguyên
 projectId,Scratch   <project-context>  MCP "project"   save_notebook  handoff_to_research   Kernel Env/project
 UI picker, list     <project-update>   read/grep/log   write_note     Open in notebook       Kaggle theo project
 cây Code/Artifacts                     paper_search    push_to_vm     copilot                alphaXiv MCP
```

---

## Quyết định thiết kế chính

### 1. Lưu liên kết project

- Liên kết nằm trong file riêng `chats/<hash>.meta.json`: `key`, `projectId`, `title`, `url`, `platform`, `agentId`, `updatedAt`.
- File riêng vì "New chat" xoá transcript, nhưng notebook vẫn phải ở trong project của nó.
- Bridge quyết định project, vì `ui/app.tsx:111` tự gửi `chat.open`. `chat.open` có thêm `projectId` tuỳ chọn, chỉ dùng để ghi đè.
- Method mới:
  - `notebook.link {notebookKey, projectId}` để chuyển notebook sang project khác;
  - `chats.list {projectId}` để liệt kê notebook chat của một project.
- `ChatSnapshot` có thêm `project {id, name, state}`.
- Chỉ thêm trường, không đổi trường cũ. File cũ không có `projectId` thì được coi là chưa gắn và vào Scratch.

### 2. Scratch

- Tạo khi cần lần đầu, tại `~/OpenResearch/scratch`. Gọi `POST /api/projects` với `createFolder`, `initializeGit` và `githubSyncEnabled: false` để không bị đẩy lên GitHub.
- Id lưu trong `research.json`.
- Kiểm tra id bằng GET trước khi dùng. Nếu mất: tìm project "Scratch" theo path; nếu folder còn mà chưa đăng ký thì đăng ký lại với `creationMode: folder`.
- Mọi chat dùng chung một promise để không tạo trùng.

### 3. Ngữ cảnh vào prompt

- Event chỉ dùng để đánh dấu cache cũ, vì `/api/events` không phát lại event cũ khi kết nối lại.
- Đến lượt chat thì lấy digest và so với digest đã gửi, giống cách outline của notebook chỉ gửi khi đổi.
- `<project-context>` (tối đa khoảng 8k ký tự) gồm:
  - tên project và paper;
  - khoảng 40 dòng đầu của AGENTS.md / CLAUDE.md / README;
  - tối đa 30 experiment, mỗi cái kèm trạng thái và mô tả một dòng;
  - 5 run mới nhất kèm kết quả;
  - tối đa 40 artifact.
- Đường dẫn luôn tương đối với project, để không lẫn với đường dẫn trên VM. Thêm luật: "project nằm trên máy bạn, không phải trên VM".

### 4. MCP server thứ hai tên "project"

- Dùng lại stdio relay: `mcp-stdio.ts` đang gắn cứng tên "notebook", sẽ đọc thêm `AINB_MCP_SERVER`; route mới là `/mcp/project/*`.
- Tên tool vẫn có tiền tố `project_`.
- `isNotebookTool` (`chat.ts:963`) phải nhận ra tool của server "project", nếu không thì Notebook only sẽ chặn chúng.

### 5. Đọc qua API, tìm trên đĩa, ghi chỉ vào artifacts

- Đọc qua API (`/file?ref|sessionId`, `/code-tree`, `/runs/{id}/logs`). API đã lo sẵn nhánh, worktree, gitignore, giới hạn 512 KB và sau này cả remote workspace.
- Tìm bằng `git grep [branch]` trong `repoPath`.
- Ghi thẳng xuống đĩa, chỉ vào `artifactsDir`: resolve đường dẫn thật, chặn `..` và symlink trỏ ra ngoài. OpenResearch tự thấy thay đổi nhờ polling, nên phát `files.updated`.
- Không bao giờ ghi vào repo checkout. Muốn sửa code thì giao cho research agent qua handoff.
- `project_read` từ chối các file `.env`, `*.pem`, `id_*` và file key, vì nội dung đọc được sẽ gửi tới nhà cung cấp model.

### 6. cwd giữ là workspace riêng của chat

Mở agent ngay trong repo sẽ nạp hooks `.claude/settings.json` và `.mcp.json` của repo. Project tạo từ paper clone repo công khai về, nên đó là code lạ chạy trên máy bạn, và Notebook only không chặn được hooks. Đầu file AGENTS.md / CLAUDE.md đã được đưa vào brief.

### 7. Mode policy (`protocol/src/modes.ts`), thêm action `save`

| Tool                               | Edit cell | Write    | Autonomous | Khi bật Review |
|------------------------------------|-----------|----------|------------|----------------|
| Tool đọc, `paper_search`           | được      | được     | được       | không đổi      |
| `save_notebook`, `write_note` (save) | không   | được     | được       | hỏi            |
| `push_to_vm` (execute)             | không     | không    | được       | hỏi            |
| `handoff_to_research`              | luôn hỏi  | luôn hỏi | luôn hỏi   | luôn hỏi       |

Ghi đè một file mà chat này không tạo ra thì luôn hỏi.

### 8. Mặc định đã chọn sẵn (đổi được)

- `save_notebook` giữ output, giới hạn 20 MB, có tuỳ chọn bỏ output.
- File meta giữ 180 ngày (transcript vẫn 30 ngày).
- Biến môi trường của OpenResearch không đưa lên VM, vì API trả giá trị đã che. Chỉ hiện tên biến và gợi ý dùng Colab/Kaggle Secrets.
- Danh sách agent không gộp: OpenResearch chạy Claude/Codex native, không qua ACP. Chỉ lấy `/api/harnesses` để báo trạng thái đăng nhập, và cho nhập các agent ACP tự thêm bên OpenResearch.

---

## Các giai đoạn và file cần sửa

### GĐ1: Gắn project và Scratch

- Bridge:
  - mới `bridge/src/research/projects.ts`: dùng lại `getJson` của `research/orx.ts`, timeout 3 giây; có `ensureScratch` và `getProject`.
  - `server.ts`: `chat.open` xác định project; thêm `notebook.link` và `chats.list`; persist ghi meta.
  - `store.ts`: file meta, và `remove` giữ lại meta.
  - `chat.ts`: `snapshot()` có thêm `project`.
- Protocol: `protocol/src/wire.ts`.
- VS Code: `extension.ts` đi theo project trong snapshot (gọi `studio.openProject`).
- Studio:
  - `studio/src/messages.ts`;
  - `newchat.tsx` NotebookStart có ô chọn project (mặc định là project hiện tại, nếu không có thì Scratch);
  - `project.tsx` có khung "Notebook chats", làm theo mẫu ChatList.
- Chat UI: `ui/src/app.tsx` có chip project và "Move to project…" (quick pick giống `pickProjectToShow`).
- Docs: cập nhật `docs/architecture.md` và README (README cũng đang tả sai các thanh bên).

### GĐ2: Ngữ cảnh project trong prompt

- `instructions.ts`: thêm `projectContext()` và `projectUpdate()`, viết theo mẫu `turnContext`.
- `chat.ts` `buildPrompt`: dùng mẫu `rulesDue` / `lastOutline`.
- `research/orx.ts` `onEvent`: chuyển tiếp `project.updated`, `experiment.updated`, `files.updated` để đánh dấu cache cũ.

### GĐ3: Tool đọc

- Mới `bridge/src/project/tools.ts`, dùng lại `tool()`, `Denied`, `callTool`, `listTools` từ `notebook/tools.ts`. Gồm:
  - `project_overview`, `project_files`, `project_read`, `project_grep`;
  - `project_experiments`, `project_run_result`;
  - `project_run_log` (phân trang theo cursor, giống `read_output`);
  - `paper_search`.
- Sửa thêm: `mcp-stdio.ts`; `server.ts` `chatHost.mcpServer` trả về 2 server; `chat.ts` `startAgent` và `isNotebookTool`.

### GĐ4: Ghi tài liệu về project

- `modes.ts`: action `save`.
- `save_notebook`: lấy cell kèm output rồi `writeIpynb` (`ipynb.ts`), lưu vào `artifacts/notebooks/`.
- `write_note`: lưu vào `artifacts/notes/`.
- `push_to_vm`: đọc `/file/raw` rồi `vmfs.writeFile`. Giới hạn 8 MB mỗi file và khoảng 50 MB tổng; nếu project có trên GitHub thì gợi ý `git clone`.
- Nút "Save notebook to project".

### GĐ5: Chuyển chế độ

- `handoff_to_research`: `POST /api/chat/sessions`, rồi `POST …/{id}/message` với brief kèm đường dẫn notebook đã lưu. Thêm nút "Hand off to Research".
- `studio/src/experiment.tsx`: "Open in notebook copilot" tạo `.ipynb` trong artifacts, mở trong VS Code và gắn vào project.

### GĐ6: Tài nguyên dùng chung

- Kernel Environment theo project: `settings.tsx`; `extension.ts` autoSetup tìm script theo liên kết, không có thì dùng script chung, có gợi ý điền sẵn từ `requirements.txt`.
- Mở notebook Kaggle cho một project: notebook đầu tiên kết nối từ lần mở đó được gắn vào project ấy.
- Trạng thái đăng nhập agent lấy từ `/api/harnesses`.
- Tuỳ chọn: thêm `orx alphaxiv-mcp` làm MCP server thứ ba. Cần chặn tool ghi của nó bằng `disallowedTools` cho Claude; các agent khác chưa có cách chặn tương ứng.

---

## Khi có lỗi

- **orx tắt hoặc chậm**: chat và tool notebook không bao giờ chờ orx.
  - Liên kết đang chờ được lưu là "Scratch (pending)".
  - Brief ghi "project context unavailable (OpenResearch starting / not running)" và tool project báo đúng lỗi đó.
  - Bridge gọi `orx.start()` chạy nền.
  - Lỗi mạng được báo là "không xác định", không bao giờ là "project bị xoá".
- **Project bị xoá (404)**: hiện thông báo kèm "Move to project…", không tự chuyển. Riêng Scratch cũ thì tự chuyển sang Scratch mới và có thông báo.
- **Project bị chuyển chỗ**: báo nguyên lỗi repo clone unavailable của OpenResearch; artifacts vẫn dùng được.
- **Mở cùng notebook ở tab khác**: cùng key, nên cùng meta, cùng project và cùng transcript.
- **Đổi project giữa lượt**: áp dụng từ lượt sau, gửi lại `<project-context>` đầy đủ và thông báo cho agent.
- **Remote workspace**: ô chọn chỉ hiện project trên máy này; liên kết có sẵn trường `workspace` để dùng sau.

## Kiểm tra (mỗi giai đoạn)

- `pnpm -r typecheck` và `pnpm -r test`.
- Viết test cho bridge (vitest, dùng `test/fixtures/fake-agent.mjs` và một orx giả) cho:
  - liên kết và meta, Scratch được tạo đúng một lần, file cũ không có `projectId`;
  - digest và `<project-update>`;
  - mode policy của từng tool mới;
  - chặn đường dẫn ra ngoài artifacts.
- Chạy thật:
  1. Mở notebook Colab, chọn New Chat › Notebook, chọn Project X.
  2. Hỏi "project này có những thí nghiệm nào, run nào tốt nhất" để agent dùng `<project-context>` và `project_run_result`.
  3. Chạy `save_notebook` và kiểm tra file hiện trong cây Artifacts của VS Code và của dashboard OpenResearch.
  4. Chạy `handoff_to_research` và kiểm tra research chat mới xuất hiện trong Project X.
  5. Tắt orx giữa chừng: chat notebook vẫn chạy và brief báo "unavailable".
