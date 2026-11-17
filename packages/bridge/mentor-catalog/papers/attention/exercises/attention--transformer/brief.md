Ráp **Transformer encoder-decoder đầy đủ** (§3, Figure 1) từ các mảnh bạn đã viết: `PositionalEmbedding` (bài `attention--posenc-embed`), `EncoderLayer` (bài `attention--encoder-layer`) và `DecoderLayer` (bài `attention--decoder-layer`). Đây là bản thu nhỏ để học "dịch" đồ chơi (đảo chuỗi chữ số); cỡ mặc định nhỏ để train được trên CPU.

Luồng dữ liệu (§3.1, §3.4, §5.4): câu nguồn `src` qua embedding rồi một chồng `n_layers` lớp encoder, ra `memory`. Chuỗi đích đã dịch một vị trí `tgt_in` (bắt đầu bằng `BOS`) qua embedding rồi một chồng `n_layers` lớp decoder, mỗi lớp cross-attention vào cùng `memory`. Cuối cùng một phép tuyến tính đưa về logits trên từ vựng.

**`class Transformer(nn.Module)`**, khởi tạo:

`Transformer(vocab_size, d_model=64, n_heads=4, d_ff=128, n_layers=2, dropout=0.1, max_len=64)`

| thuộc tính | là gì |
|---|---|
| `embed` | `PositionalEmbedding(vocab_size, d_model, max_len)` (của bạn), **một** đối tượng dùng cho cả `src` lẫn `tgt_in` (hai chuỗi chung một từ vựng nhỏ) |
| `drop` | `nn.Dropout(dropout)`: §5.4 áp dropout lên tổng embedding và positional encoding, ở cả hai chồng |
| `enc_layers` | `nn.ModuleList` gồm `n_layers` lớp `EncoderLayer(d_model, n_heads, d_ff, dropout)` |
| `dec_layers` | `nn.ModuleList` gồm `n_layers` lớp `DecoderLayer(d_model, n_heads, d_ff, dropout)` |
| `out` | `nn.Linear(d_model, vocab_size, bias=False)` có **trọng số dùng chung** với embedding (§3.4: *"we share the same weight matrix between the two embedding layers and the pre-softmax linear transformation"*): `out.weight` và `embed.embed.weight` là **cùng một** `nn.Parameter`, không phải hai bản sao |

**`forward(src, tgt_in)`**:

- `src`: `(B, S)` int64; `tgt_in`: `(B, T)` int64;
- trả về **logits** `(B, T, vocab_size)` (chưa softmax);
- hai mask bool lấy từ hàm **cho sẵn** `make_masks(src, tgt_in)` (nằm trong phần "Cho sẵn của paper", bạn không phải viết): `src_mask` cho self-attention của encoder **và** cho cross-attention của decoder; `tgt_mask` (causal, có che PAD) cho self-attention của decoder.

Chiều ra của mỗi mảnh đã khớp nhau, nên bài này là chuyện nối đúng đối tượng vào đúng chỗ: ai nhận mask nào, ai nhận `memory`, và chỗ nào chia sẻ trọng số. Không thêm LayerNorm cuối nào (post-LN đã chuẩn hóa ở cuối mỗi lớp).
