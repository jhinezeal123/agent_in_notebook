import random


def _text(seed, n, alphabet="abcde f"):
    rng = random.Random(seed)
    return "".join(rng.choice(alphabet) for _ in range(n))


def _diff(got, want):
    for i in range(max(len(got), len(want))):
        if i >= len(got) or i >= len(want) or got[i] != want[i]:
            return i + 1
    return 0


def test_return_type(user, ref):
    """Trả về list các tuple (trái, phải) gồm hai str"""
    f = need(user, "learn_merges")
    out = f("abab", 1)
    assert isinstance(out, list), f"Kết quả có kiểu {type(out).__name__}, cần list."
    assert len(out) == 1, f"Với 'abab' và 1 vòng, bảng có {len(out)} phần tử, cần đúng 1."
    pair = out[0]
    assert isinstance(pair, tuple) and len(pair) == 2, f"Mỗi phần tử phải là tuple (trái, phải); bạn trả về {pair!r}."
    assert all(isinstance(x, str) for x in pair), f"Hai phần của một cặp phải là str; bạn trả về {pair!r}."
    assert pair == ("a", "b"), f"Với 'abab' vòng đầu phải chọn ('a', 'b'), bạn chọn {pair!r}."


def test_hand_examples(user, ref):
    """Hai ví dụ tính tay: 'aaabdaaabac' và 'abababab'"""
    f = need(user, "learn_merges")
    got = f("aaabdaaabac", 3)
    want = [("a", "a"), ("a", "b"), ("aa", "ab")]
    assert got == want, f"Với 'aaabdaaabac', 3 vòng: bạn ra {got}, cần {want}. Vòng 1 cặp nào nhiều nhất? Sau khi thay, đếm lại trên chuỗi mới."
    got = f("abababab", 3)
    want = [("a", "b"), ("ab", "ab"), ("abab", "abab")]
    assert got == want, f"Với 'abababab', 3 vòng: bạn ra {got}, cần {want}. Mỗi vòng phải đếm trên chuỗi đã được merge ở vòng trước."


def test_recount_after_merge(user, ref):
    """Mỗi vòng đếm lại trên chuỗi đã merge (token nhiều ký tự cũng thành cặp)"""
    f = need(user, "learn_merges")
    text = "abcabcabcabdabd"
    got, want = f(text, 6), ref["learn_merges"](text, 6)
    assert got == want, f"Bảng merge với {text!r}, 6 vòng, lệch từ vòng {_diff(got, want)}: sau mỗi lần thay, các cặp liền kề đã đổi."


def test_tie_break(user, ref):
    """Hòa số lần: chọn cặp nhỏ nhất theo thứ tự tuple, không theo thứ tự xuất hiện"""
    f = need(user, "learn_merges")
    got = f("dcba", 3)
    want = [("b", "a"), ("c", "ba"), ("d", "cba")]
    assert got == want, f"Với 'dcba' mọi cặp đều 1 lần: bạn ra {got}, cần {want}. Luật hòa là gì, và nó có phụ thuộc vị trí cặp trong văn bản không?"
    got = f("zzaazz xxyyxx", 4)
    want = ref["learn_merges"]("zzaazz xxyyxx", 4)
    assert got == want, f"Lệch ở nhiều cặp hòa: bạn ra {got}, cần {want}."


def test_overlap(user, ref):
    """Cặp chồng lấn ('aaa'): đếm cả hai lần, thay từ trái sang phải không chồng"""
    f = need(user, "learn_merges")
    got = f("aaazyzy", 1)
    assert got == [("a", "a")], f"Với 'aaazyzy' ('a','a') xuất hiện 2 lần (chồng lấn) ngang ('z','y'); luật hòa chọn ('a','a'). Bạn ra {got}."
    got = f("aaaaa", 2)
    want = [("a", "a"), ("aa", "a")]
    assert got == want, f"Với 'aaaaa' bạn ra {got}, cần {want}. Sau vòng 1 chuỗi là gì nếu quét từ trái sang phải, không chồng lấn?"
    got = f("aaaaaaaa", 4)
    want = ref["learn_merges"]("aaaaaaaa", 4)
    assert got == want, f"Với 'aaaaaaaa' bạn ra {got}, cần {want}."


def test_short_and_empty(user, ref):
    """Văn bản rỗng, một ký tự, num_merges = 0, và num_merges lớn hơn số cặp có thể merge"""
    f = need(user, "learn_merges")
    assert f("", 5) == [], "Văn bản rỗng phải cho []."
    assert f("x", 5) == [], "Văn bản một ký tự không có cặp nào: phải cho []."
    assert f("abab", 0) == [], "num_merges = 0 phải cho []."
    got = f("abab", 50)
    assert got == [("a", "b"), ("ab", "ab")], f"Với 'abab' và 50 vòng: bạn ra {got}. Khi chuỗi chỉ còn một token thì làm gì?"


def test_unicode_and_spaces(user, ref):
    """Đơn vị là ký tự: dấu cách, xuống dòng và chữ có dấu đều là token như mọi ký tự"""
    f = need(user, "learn_merges")
    assert f("éé", 1) == [("é", "é")], f"Với 'éé' bạn ra {f('éé', 1)}; mỗi ký tự Unicode là một token."
    text = "xin chào việt nam, xin chào thế giới\nviệt nam"
    got, want = f(text, 10), ref["learn_merges"](text, 10)
    assert got == want, f"Với câu tiếng Việt có dấu cách và xuống dòng, bảng merge lệch: bạn ra {got[:5]}…, cần {want[:5]}…"


def test_larger_text(user, ref):
    """Văn bản ngẫu nhiên dài 1500 ký tự, 25 vòng: khớp lời giải chuẩn"""
    f = need(user, "learn_merges")
    for seed, alphabet in [(0, "abcde f"), (1, "ab"), (2, "abcdefghij")]:
        text = _text(seed, 1500, alphabet)
        got, want = f(text, 25), ref["learn_merges"](text, 25)
        assert got == want, f"Bảng merge lệch (seed {seed}) ở vòng {_diff(got, want)}."
