# Lỗi "The kernel is busy running a cell" khi chạy `ainb mentor verify`

Ghi ngày 17/11/2026, trong lúc kiểm các bài Mentor đợt 3–4 trên Kaggle (`pnpm ainb mentor verify`). Tài liệu ghi hiện tượng, bằng chứng, nguyên nhân nghi ngờ và **cách đã sửa** (mục 6). Nguyên nhân là suy luận từ bằng chứng, chưa được xác nhận bằng log; xem mục 6.3 về cách xác nhận.

## 1. Hiện tượng

`ainb mentor verify <id…>` chạy tốt, nhưng thỉnh thoảng dừng giữa chừng với:

```
Error: The kernel is busy running a cell, so this would wait behind it. Wait for the cell (wait_for_cells) or stop it (interrupt_kernel), then try again.
```

- Lỗi này **không phải bài sai**: không có dòng `✗` của bài nào. Chạy lại đúng bài đó thì qua.
- Khi nó xảy ra giữa một lượt nhiều bài, **cả lượt dừng ngay** (các bài sau không được chạy), nhưng những bài đã đạt trước đó vẫn được ghi vào `verified.json` (`Recorded N in …`).
- Lúc xảy ra, notebook không có cell nào người dùng đang chạy (người dùng chỉ nối bridge và chờ).

## 2. Các lần gặp (17/11/2026)

| Lần chạy | Kết quả |
|---|---|
| 4 bài `torch-*` | Không lỗi kernel (1 bài trượt vì lỗi nội dung, xem mục 6) |
| `torch-tensor-ops` (1 bài, sau khi sửa) | Không lỗi |
| 28 bài của các gói trong một lượt | Đạt 13 bài, rồi **lỗi giữa bài `p-sample`**, ngay sau dòng `p-sample: chấm bản sai no-noise-term…` (tức giữa hai lần chấm bản sai của cùng một bài) |
| `p-sample` (1 bài) | Đạt |
| 14 bài còn lại trong một lượt | Đạt `flow-matching-loss`, rồi **lỗi ngay ở bước đầu của bài kế tiếp** (`euler-sampler`) |
| 13 bài, mỗi bài một lệnh riêng (vòng lặp thử lại tối đa 4 lần) | **4 trên 13 bài** gặp lỗi ở lần thử đầu: `patch-embed`, `dqn-td-loss`, `reinforce-loss`, `ppo-update`. Cả 4 đều qua ở lần thử thứ 2 |
| `info-nce-temperature` (1 bài) | Không lỗi |

Quan sát: lỗi gặp **ngay sau khi một lệnh/bài trước vừa xong**, kể cả khi lệnh trước là một tiến trình `ainb` khác đã thoát. Không thấy lần nào lỗi kéo dài qua lần thử lại.

## 3. Lỗi nằm ở đâu trong code

1. **Nơi ném lỗi**: `packages/extension/src/page/jupyter.ts`, `startExecution` (dòng ~262):

   ```ts
   const kernel = await this.readyKernel();
   if (kernel.status === "busy") throw new OpError(KERNEL_BUSY);
   ```

   Chữ lỗi là hằng `KERNEL_BUSY` trong `packages/protocol/src/adapter.ts` (dòng ~315). Adapter Colab có đoạn tương tự (`k.isBusy?.()` trong `colab.ts`).

2. **Nơi gọi từ `verify`**: `packages/bridge/src/server.ts`, đường `/mentor/verify` (dòng ~955–965). Bản bọc `exec` gọi `notebookOp({ op: "execute", … })` **không thử lại** khi gặp lỗi này. Lỗi thoát ra `catch` ngoài cùng, ghi `{ t: "error", message }` (không có `exerciseId`) và **kết thúc cả vòng `for` qua các bài**.

3. **Cách `verify` chạy**: mỗi lần chấm (lời giải chuẩn, starter, từng bản sai, Phòng công thức) là **một lần `execute` riêng**, gửi liên tiếp ngay khi lần trước trả lời.

## 4. Nguyên nhân nghi ngờ (chưa chứng minh)

Một cuộc đua (race) giữa **câu trả lời `execute_reply`** và **tin báo trạng thái `status: idle`** của kernel Jupyter:

- Kernel gửi `execute_reply` (lần chạy xong) và gửi `status: idle` (trên kênh IOPub) là hai thông điệp riêng; `idle` có thể tới sau `execute_reply` một chút.
- Bridge chờ `execute_reply` rồi gửi ngay lần `execute` kế tiếp. Lúc đó `kernel.status` ở phía trang vẫn là `"busy"` (chưa kịp nhận `idle`), nên `startExecution` từ chối.
- Khớp với bằng chứng: lỗi xuất hiện ngay sau một lần chạy vừa kết thúc; luôn biến mất khi thử lại; xảy ra cả giữa hai lần chấm bản sai của cùng một bài (nên không phải do "bài trước chưa thoát").
- Có thể còn yếu tố phụ: cell cuối của bài (Phòng công thức, vẽ matplotlib) kết thúc chậm hơn dự kiến, nên lần `execute` đầu của tiến trình kế tiếp đụng đúng lúc kernel chưa về idle.

Nguyên nhân khác cũng khớp bằng chứng: trang Kaggle tự gửi những yêu cầu nhỏ cho kernel (tự hoàn thành, hỏi thông tin kernel, …), mỗi lần như vậy cờ `status` bật `busy` trong chốc lát dù không có cell nào chạy.

Chưa ghi log để phân biệt hai nguyên nhân. Cách sửa ở mục 6 không cần phân biệt.

## 5. Cách xử lý tạm thời (đã dùng trước khi sửa code)

- Chạy từng bài một lệnh, tự thử lại tối đa 4 lần **chỉ khi** đầu ra chứa `kernel is busy`; lỗi khác (`✗`) không thử lại. Mọi bài từng bị lỗi đều qua ở lần thử 2.
- Bài đã đạt vẫn được ghi, nên chạy lại phần còn lại không làm mất kết quả.

## 6. Đã sửa (17/11/2026)

Sửa **một chỗ**, ở gốc: `packages/extension/src/page/jupyter.ts`, `startExecution`.

### 6.1 Cách sửa
Trước đây `startExecution` từ chối khi cờ `kernel.status` của kernel đang là `"busy"`. Cờ này không đúng với điều lời báo lỗi muốn nói ("lệnh này sẽ phải xếp hàng sau một cell đang chạy"):

- nó vẫn ghi `"busy"` một lúc sau khi lần chạy trước đã xong (mục 4);
- nó cũng bật `"busy"` khi chính trang Kaggle hỏi kernel những việc nhỏ (tự hoàn thành, thông tin kernel, …), lúc đó không có gì phải chờ.

Giờ `startExecution` chỉ từ chối khi **thật sự có thứ phải xếp hàng sau**:

1. một **cell** của notebook đang chạy (dùng lại hàm `running()` sẵn có, cũng là hàm mà ô trạng thái kernel và `wait_for_cells` dùng); hoặc
2. một **lần chạy trước của chính `startExecution`** chưa xong (ví dụ lần trước quá thời gian chờ mà code vẫn chạy). Adapter tự ghi các lần chạy này (`ownRuns`) và xóa khi `future.done` của nó xong.

Không chờ, không thử lại, không thêm tham số thời gian. Câu chữ lỗi `KERNEL_BUSY` giữ nguyên (`mentor-contract.test.ts` vẫn qua).

Cách này không phụ thuộc nguyên nhân nào trong mục 4 là đúng: cả "cờ cũ chưa kịp đổi" lẫn "trang đang hỏi kernel việc nhỏ" đều không còn làm lệnh bị từ chối.

### 6.2 Phạm vi và hệ quả
- Chỉ đổi adapter Jupyter/Kaggle. Adapter Colab không đổi (chưa thấy lỗi ở đó).
- Có lợi cho cả chat và agent, không riêng Mentor: lệnh chạy code của chúng đi qua cùng `startExecution`.
- Một trường hợp hiếm không còn bị chặn: kernel đang chạy code do **một trang/trình khác** gửi tới (không phải cell của notebook này, không phải lần chạy của adapter). Khi đó lệnh mới xếp hàng chờ và, nếu quá lâu, báo "hết giờ" thay vì "kernel bận".
- Đã thử hai cách khác rồi bỏ: (a) cho `verify` tự thử lại khi gặp lỗi bận, (b) cho trang chờ tối đa 1,5 s để cờ chuyển về `idle`. Cả hai chỉ né triệu chứng, cộng thêm thời gian chờ và chỉ chữa được nguyên nhân "cờ cũ", không chữa nguyên nhân "trang hỏi việc nhỏ".

### 6.3 Kiểm tra
- `tsc --noEmit` của `extension` sạch; test `op-runner`, `server-python` (extension), `mentor-contract`, `mentor-verify` (bridge) đều qua.
- **Chưa xác nhận trên Kaggle.** Sau khi nạp bản mới (mục 6.4), chạy `ainb mentor verify` trên một lượt nhiều bài. Nếu không còn lỗi "kernel is busy" là xong; nếu vẫn còn thì ghi lại `kernel.status`, cell nào bị coi là đang chạy và `ownRuns.size` ngay lúc từ chối để tìm tiếp.

### 6.4 Để bản sửa có hiệu lực
Bản sửa nằm trong extension Chrome (phần chạy trong trang Kaggle), không trong bridge:
1. Build extension (`pnpm --filter @ainb/extension build`).
2. Nạp lại extension ở `chrome://extensions` rồi tải lại trang Kaggle, nối lại bridge.

Bước 2 làm đứt phiên đang chạy, nên không làm khi đang verify.

## 7. Lỗi nhỏ khác gặp cùng lúc (chưa sửa)

- `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76` (mã thoát 3221226505) xuất hiện một lần ở cuối `ainb mentor verify p-sample`, **sau** dòng `Recorded 1 in …`. Là lỗi tắt tiến trình Node/libuv trên Windows, không ảnh hưởng kết quả đã ghi; chỉ làm mã thoát khác 0.

## 8. Lỗi nội dung do `verify` bắt được (không liên quan kernel busy)

Để khỏi nhầm với phần trên:

- `torch-tensor-ops` (bộ gốc 3a): `reference.py` viết `einsum("bhtd,bhsd->bhst")`, ngược với đề `(B, H, T, S)`. Đã sửa thành `->bhts` ở `reference.py`, bốn bản sai trong `mutants/` (chép cùng chuỗi sai) và câu hỏi trong `probes.json`.
- `info-nce-temperature` (nhánh CV): bản sai `no-clamp` lọt qua vì test `test_clamp` dùng hai view quá giống nhau (`z2 + 2·z1`), loss bão hòa nên τ = 0.01 và τ = 0.002 cho cùng kết quả. Đã giảm xuống `z2 + 0.5·z1` trong `tests.py`; sau đó bài đạt.
- `attention--reverse-experiment`: train trên CPU mất khoảng 17 phút một lượt kiểm (đề ghi "3 phút"). Đã cho lời giải chuẩn, các bản sai và gợi ý trong đề dùng GPU khi có; đạt, khoảng 14 phút cho cả bài kể cả các bản sai.
- `dqn--experiment`: lời giải chuẩn nộp mạng ở bước cuối, rơi vào đáy một đợt dao động của DQN (mean_return 79,9 < 100). Đã cho nó (và các bản sai) đo chính sách tham lam mỗi 1 000 bước trên 5 episode seed riêng và giữ bản trọng số tốt nhất; đề đưa bước này vào bảng cấu hình. Đạt: 199,3.
- `resnet--experiment`: lời giải chuẩn luôn quá 15 phút, kể cả khi chỉ train 3 epoch: kẹt ở bước tải CIFAR-10 từ máy chủ gốc (Toronto, rất chậm; bị dừng giữa chừng thì lần sau tải lại từ đầu). `load_cifar10` trong `papers/resnet/given.py` giờ tải từ Hugging Face (`uoft-cs/cifar10`) trước, torchvision sau. Đạt: lời giải chuẩn 465 s, acc_res 0,758.

## 9. Chạy nhiều bài cùng lúc trên các GPU của máy

Trước đây `verify` chạy từng lần chấm một trong kernel, nên trên máy Kaggle 2 × T4 chỉ một GPU làm việc. Giờ (`packages/bridge/src/mentor/pool.ts`, dùng ở đường `/mentor/verify` của `server.ts`):

- Kernel giữ một **bộ chạy nền**: mỗi GPU 2 chỗ (không có GPU: nửa số CPU), mỗi lần chấm là một tiến trình Python riêng chỉ thấy GPU của chỗ đó. Bridge gửi việc và lấy kết quả bằng một lệnh ngắn mỗi 3 giây; giữa hai lệnh kernel rảnh.
- Mọi lần chấm của mọi bài (lời giải chuẩn, starter, bản sai, Phòng công thức) xếp hàng chung: chỗ nào rảnh thì nhận việc kế tiếp, kể cả của bài khác. Trong một bài, lời giải chuẩn chạy trước (nó có thể tải dữ liệu mà các lần sau dùng), rồi các lần còn lại gửi cùng lúc. Mỗi bài chạy trong thư mục riêng.
- Việc của bài thí nghiệm train trên GPU có hàng riêng và được nhận trước; chỗ của GPU chỉ nhận việc CPU khi hàng GPU trống.
- Bản sai của bài thí nghiệm bị dừng vì quá giờ thì báo "chưa đo được", không còn được tính là đã bắt; tiến trình chết không ra kết quả thì báo "không có kết quả".
- Bài đạt được ghi vào `verified.json` ngay khi xong, không chờ cả lượt.

Kết quả: 10 bài paper trong khoảng 55 phút, thay vì hơn 17 phút cho riêng một bài thí nghiệm khi chạy lần lượt trên CPU. Hai ý cuối (hàng GPU riêng, bản sai quá giờ) đã build nhưng chỉ có hiệu lực từ lần khởi động lại bridge kế tiếp.

## 10. Trạng thái

- **Mọi bài cần PyTorch đã đạt trên Kaggle** và có dấu trong `verified.json`: 4 bài `torch-*`, 28 bài của bốn gói `packs/branch-*`, 18 bài của bảy paper. `mentor-catalog.test.ts`: 210/210.
- Sửa lỗi kernel busy (mục 6): đã nạp vào Chrome; các lượt chạy sau đó (bốn lượt, một lượt 10 bài) không gặp lại lỗi. Chưa phải bằng chứng chắc: cách chạy ở mục 9 gửi lệnh vào kernel thưa hơn trước.
