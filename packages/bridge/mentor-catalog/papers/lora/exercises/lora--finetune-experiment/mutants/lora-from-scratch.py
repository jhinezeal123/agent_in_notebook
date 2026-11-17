import copy

torch.manual_seed(0)
base = pretrain()


def finetune(model, params, lr, steps, seed):
    opt = torch.optim.Adam(params, lr=lr)
    gen = torch.Generator().manual_seed(seed)
    model.train()
    for _ in range(steps):
        x = make_batch("B", 64, gen)
        _, loss = model(x, x)
        opt.zero_grad()
        loss.backward()
        opt.step()
    return model


model_full = copy.deepcopy(base)
finetune(model_full, model_full.parameters(), 1e-3, 300, 1)

model_lora = add_lora(GPT(*GPT_CONFIG), r=4, alpha=8, targets=["attn.qkv", "attn.proj"])
finetune(model_lora, [p for p in model_lora.parameters() if p.requires_grad], 3e-3, 300, 1)
