Một batch câu đã được pad về cùng độ dài. Mô hình cho `log_probs` shape `(B, T, V)` (log-xác suất trên từ vựng `V` tại mỗi vị trí), nhãn đúng `targets` shape `(B, T)` (số nguyên trong `[0, V)`), và `mask` shape `(B, T)` (1/True ở token thật, 0/False ở padding).

Viết `masked_nll(log_probs, targets, mask)` trả về **một số thực**:

$$\mathcal{L} = -\frac{1}{\sum_{b,t} m_{bt}} \sum_{b,t} m_{bt}\, \log p_{b,t,\,y_{bt}}$$

- Không dùng vòng lặp Python.
- Vị trí padding không được ảnh hưởng kết quả, kể cả khi `log_probs` ở đó là số rất lớn.
- Nếu mask toàn 0 thì trả về `0.0`.
