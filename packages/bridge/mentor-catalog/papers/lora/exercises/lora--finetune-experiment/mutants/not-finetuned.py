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

model_lora = add_lora(copy.deepcopy(base), r=4, alpha=8, targets=["attn.qkv", "attn.proj"])
