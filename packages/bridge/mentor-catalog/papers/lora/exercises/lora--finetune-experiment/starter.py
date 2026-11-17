# Cell train. Chạy xong cell này, hai biến toàn cục `model_full` và `model_lora` phải giữ hai mô hình đã fine-tune trên tác vụ B.
# (cần `import copy` để sao chép mô hình)
torch.manual_seed(0)

# 1. Mô hình huấn luyện trước trên tác vụ A (gọi pretrain() đúng một lần).
base = ...

# 2. Fine-tune toàn bộ tham số trên tác vụ B.
model_full = ...

# 3. Gắn LoRA (add_lora của bạn, r=4, alpha=8, attn.qkv và attn.proj) rồi chỉ fine-tune adapter trên tác vụ B.
model_lora = ...

# 4. Gợi ý: in eval_loss(model, "B") của từng mô hình, và count_params(model_lora), để xem bằng mắt trước khi bấm Chấm bài.
