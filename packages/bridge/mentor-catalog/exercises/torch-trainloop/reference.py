def train_epoch(model, batches, opt, loss_fn):
    model.train()
    total, count = 0.0, 0
    for x, y in batches:
        opt.zero_grad()
        loss = loss_fn(model(x), y)
        loss.backward()
        opt.step()
        total += loss.item() * len(x)
        count += len(x)
    return total / count


def evaluate(model, batches, loss_fn):
    model.eval()
    total, correct, count = 0.0, 0, 0
    with torch.no_grad():
        for x, y in batches:
            logits = model(x)
            total += loss_fn(logits, y).item() * len(x)
            correct += (logits.argmax(dim=-1) == y).sum().item()
            count += len(x)
    return total / count, correct / count
