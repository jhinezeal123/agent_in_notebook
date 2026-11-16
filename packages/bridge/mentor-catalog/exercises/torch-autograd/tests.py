def _regression(seed):
    g = torch.Generator().manual_seed(seed)
    X = torch.randn(10, 3, generator=g)
    y = torch.randn(10, generator=g)
    w = torch.randn(3, generator=g).requires_grad_()
    b = torch.zeros((), requires_grad=True)
    return X, y, w, b


def _expected(X, y, w, b):
    r = (X @ w + b - y).detach()
    return 2 * X.T @ r / len(y), 2 * r.mean()


def _td(seed):
    g = torch.Generator().manual_seed(seed)
    q_sa = torch.randn(6, generator=g).requires_grad_()
    r = torch.randn(6, generator=g)
    q_next = torch.randn(6, 4, generator=g).requires_grad_()
    return q_sa, r, q_next


def _nets():
    t.seed(0)
    target = nn.Linear(3, 2)
    t.seed(1)
    online = nn.Linear(3, 2)
    return target, online


def test_grads_values(user, ref):
    """grads_of: đúng gradient của MSE theo w và b"""
    f = need(user, "grads_of")
    X, y, w, b = _regression(0)
    gs = f(lambda: ((X @ w + b - y) ** 2).mean(), [w, b])
    assert isinstance(gs, (list, tuple)) and len(gs) == 2, "grads_of phải trả về một list, mỗi tham số một gradient."
    gw, gb = _expected(X, y, w, b)
    t.shape(gs[0], (3,), what="gradient theo w")
    t.shape(gs[1], (), what="gradient theo b")
    t.close(gs[0], gw, what="gradient theo w")
    t.close(gs[1], gb, what="gradient theo b")


def test_grads_no_side_effect(user, ref):
    """grads_of không đụng tới .grad của tham số, gọi lại vẫn ra như cũ"""
    f = need(user, "grads_of")
    X, y, w, b = _regression(1)
    loss_fn = lambda: ((X @ w + b - y) ** 2).mean()
    first = [g.detach().clone() for g in f(loss_fn, [w, b])]
    assert w.grad is None and b.grad is None, "Sau grads_of, w.grad hoặc b.grad không còn là None: gradient đã bị ghi vào tham số."
    second = f(loss_fn, [w, b])
    for a, c in zip(first, second):
        t.close(c, a, what="gradient ở lần gọi thứ hai")
    seven = torch.full_like(w, 7.0)
    w.grad = seven.clone()
    third = f(loss_fn, [w, b])
    assert w.grad is not None, "w.grad có sẵn từ trước đã bị xoá."
    t.close(w.grad, seven, what="w.grad có sẵn từ trước")
    t.close(third[0], first[0], what="gradient trả về khi w.grad đã có giá trị từ trước")


def test_td_value(user, ref):
    """td_loss: một số vô hướng, đúng giá trị"""
    f = need(user, "td_loss")
    q_sa, r, q_next = _td(2)
    loss = f(q_sa, r, q_next, 0.9)
    t.shape(loss, (), what="td_loss")
    t.close(loss, ref["td_loss"](q_sa, r, q_next, 0.9), what="td_loss (target lấy max theo trục hành động)")


def test_td_grads(user, ref):
    """td_loss: gradient chảy vào q_sa, không chảy vào q_next"""
    f = need(user, "td_loss")
    q_sa, r, q_next = _td(3)
    loss = f(q_sa, r, q_next, 0.9)
    loss.backward()
    assert q_sa.grad is not None, "q_sa không nhận được gradient."
    y = r + 0.9 * q_next.detach().max(dim=-1).values
    t.close(q_sa.grad, 2 * (q_sa.detach() - y) / 6, what="gradient theo q_sa")
    leaked = q_next.grad is not None and float(q_next.grad.abs().sum()) > 0
    assert not leaked, "Gradient chảy vào q_next (mạng target): y phải được coi là hằng số khi tối ưu."


def test_ema_values(user, ref):
    """ema_update: đúng giá trị, sửa tại chỗ, online không đổi"""
    f = need(user, "ema_update")
    target, online = _nets()
    t0 = [p.detach().clone() for p in target.parameters()]
    o0 = [p.detach().clone() for p in online.parameters()]
    res = f(list(target.parameters()), list(online.parameters()), 0.9)
    assert res is None, "ema_update không trả về gì: nó sửa tham số tại chỗ."
    for name, p, a, o in zip(["weight", "bias"], target.parameters(), t0, o0):
        t.close(p, 0.9 * a + 0.1 * o, what=f"target.{name} sau một lần cập nhật (tau = 0.9)")
    for p, o in zip(online.parameters(), o0):
        assert torch.equal(p.detach(), o), "online_params bị thay đổi."


def test_ema_stays_leaf(user, ref):
    """ema_update: tham số target vẫn là tensor lá, vẫn train được"""
    f = need(user, "ema_update")
    target, online = _nets()
    params = list(target.parameters())
    f(params, list(online.parameters()), 0.5)
    for p in target.parameters():
        assert p.requires_grad, "Sau cập nhật, tham số target không còn requires_grad: optimizer sẽ không train được nó nữa."
        assert p.is_leaf and p.grad_fn is None, "Phép cập nhật bị autograd ghi vào đồ thị: tham số target không còn là tensor lá."
    assert all(a is b for a, b in zip(params, target.parameters())), "Tham số target phải vẫn là chính những tensor cũ."
    target(torch.ones(4, 3)).sum().backward()
    assert target.weight.grad is not None, "Sau cập nhật, target không còn nhận gradient."
    assert all(p.grad is None for p in online.parameters()), "backward trên target lại sinh gradient cho online: hai mạng đang bị nối trong đồ thị."
