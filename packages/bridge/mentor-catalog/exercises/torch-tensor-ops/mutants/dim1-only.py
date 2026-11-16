def pairwise_sq_dists(x, y):
    diff = x[:, None, :] - y[None, :, :]
    return (diff ** 2).sum(dim=-1)


def pick_logprobs(logits, targets):
    logp = F.log_softmax(logits, dim=1)
    return logp.gather(1, targets.unsqueeze(1)).squeeze(1)


def batched_scores(q, k):
    d = q.shape[-1]
    return torch.einsum("bhtd,bhsd->bhst", q, k) / d ** 0.5
