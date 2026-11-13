# Dự định: Colab tới máy không qua kernel

Trạng thái (13/11/2026): **hoãn**, chờ dùng Colab trả phí. Hiện Colab vẫn đi qua kernel.

## Hiện tại

Trên Kaggle và Jupyter, `machine_exec` đi qua một terminal của Jupyter server (`page/server-python.ts`). Nhờ vậy cell đang chạy không chặn terminal, file trên máy hay việc đồng bộ file notebook. Colab không có terminal kiểu đó, nên mọi helper đi qua kernel. Khi một cell đang chạy:

- agent tạm không đọc được terminal, không đọc/ghi được file trên máy;
- file notebook trên máy không được cập nhật;
- lệnh đang chạy trong terminal vẫn chạy tiếp, cell xong là agent làm tiếp;
- notebook vẫn đọc/sửa được qua đường dẫn file của nó (đi thẳng vào trình duyệt).

## Vì sao không dùng `/colab/tty`

Đây là terminal của bảng Terminal trong Colab (`notebook.getKernel().getTerminalConnection()`). Giao thức lấy từ lệnh `colab console` cũ của [google-colab-cli](https://github.com/googlecolab/google-colab-cli) (gỡ ngày 29/10/2026, mã ở commit `930275e`, `src/colab_cli/console.py`):

- `wss://<runtime>/colab/tty?colab-runtime-proxy-token=<token>`
- hai chiều đều là JSON `{"data": "..."}`; đổi kích thước bằng `{"cols": …, "rows": …}`
- phía sau là bash chạy trong **tmux**

tmux vẽ lại màn hình, nên những gì gửi về là cập nhật màn hình chứ không phải dòng byte: reply dài bị cắt theo khung và trôi mất. Nhiều khả năng các kết nối còn chung một phiên tmux với bảng Terminal của user. Không hợp làm kênh yêu cầu/trả lời. Chính Google cũng đã bỏ đường này để chuyển sang SSH.

## Kế hoạch: SSH chính thức (`/colab/ssh`)

Google có `colab ssh` chính thức (google-colab-cli, từ 07/2026, tài liệu `docs/06_ssh_access.md`):

- `wss://<runtime>/colab/ssh?colab-runtime-proxy-token=<token>`, bên trong là giao thức SSH thường
- khóa công khai gửi trong header `X-Colab-Ssh-Pubkey` (chỉ `ssh-ed25519`, `ecdsa-sha2-nistp*`; RSA bị từ chối)
- mã lỗi khi bắt tay: 400 khóa sai, 401 token hết hạn, 404 runtime không bật SSH ("baked in at creation"), 429 hết số phiên (tùy gói), 502 sshd không trả lời
- user là `root`, thư mục làm việc nên `cd /content`; môi trường tối giản, PATH có thể thiếu so với kernel

Cách lắp vào:

1. Trình duyệt không đặt được header tùy ý cho websocket, nên **bridge** (Node) tự kết nối, dùng `ssh2` chạy trên websocket đó.
2. Trang đưa cho bridge URL runtime và token (op mới); bridge tạo khóa ed25519 riêng, giữ cục bộ.
3. Helper Python giữ nguyên: chạy qua `ssh exec` (`python3 -c …`), hoặc đổi file sang SFTP nếu đáng. Daemon terminal (`shell.ts`) vẫn giữ, vì phiên SSH mất khi kết nối rớt còn daemon thì không.
4. Lấy cwd và PATH từ kernel như hiện nay (`hello`), không dùng môi trường tối giản của SSH.
5. Thứ tự đường đi cho Colab: SSH → kernel. Lỗi 404/429/502 thì về kernel và thử lại sau.
6. **Tắt sẵn**, user bật trong cài đặt. Không tự dùng khi user chưa bật.

## Vì sao phải chờ gói trả phí

[FAQ của Colab](https://research.google.com/colaboratory/faq.html) cấm "remote control such as SSH shells" trên runtime miễn phí (không có compute unit); vi phạm có thể bị ngắt runtime, rủi ro cho tài khoản. Chưa rõ endpoint chính thức có được miễn không. Vì vậy **không dò, không dùng `/colab/ssh` trên tài khoản miễn phí**, kể cả để thử.

## Khi đã có gói trả phí: dò trước khi làm

Trên một notebook nháp đã Connect (dùng Chrome đã đăng nhập, ví dụ qua Claude in Chrome; Playwright thường bị Google chặn đăng nhập):

- [ ] Trang lấy URL runtime và `colab-runtime-proxy-token` ở đâu; token sống bao lâu.
- [ ] Runtime mở từ trình duyệt có `/colab/ssh` không (404 nghĩa là không).
- [ ] Bắt tay từ Node với token đó: kết nối được, chạy `echo` có mã thoát; số phiên tối đa (429).
- [ ] SSH có chạy song song được trong lúc một cell đang chạy không (mục đích chính).
- [ ] Ghi kết quả vào đây, rồi mới làm.

Script dò liên quan: `packages/extension/test/debug/colab-terminal-probe.mjs` (đọc mã nguồn trang Colab, tìm cách terminal kết nối).
