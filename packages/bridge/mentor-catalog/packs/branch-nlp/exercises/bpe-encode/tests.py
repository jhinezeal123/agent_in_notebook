import random

CORPUS = "low low low lower lower newest newest widest xin chào việt nam xin chào"


def _table(ref, k=12):
    return ref["learn_merges"](CORPUS, k)


def test_single_merge(user, ref):
    """Một merge: mọi chỗ có cặp liền kề đều thành một token, phần còn lại giữ nguyên"""
    enc = need(user, "encode")
    got = enc("abcab", [("a", "b")])
    assert got == ["ab", "c", "ab"], f"encode('abcab', [('a','b')]) ra {got}, cần ['ab', 'c', 'ab']."
    got = enc("xabyabz", [("a", "b")])
    assert got == ["x", "ab", "y", "ab", "z"], f"Ký tự không thuộc merge nào vẫn phải là một token riêng; bạn ra {got}."
    got = enc("ba", [("a", "b")])
    assert got == ["b", "a"], f"Cặp ('a','b') không có trong 'ba' (thứ tự quan trọng); bạn ra {got}."


def test_merge_order(user, ref):
    """Áp merge theo thứ tự học: đổi thứ tự trong bảng thì kết quả đổi"""
    enc = need(user, "encode")
    got = enc("abc", [("a", "b"), ("b", "c")])
    assert got == ["ab", "c"], f"Bảng [(a,b), (b,c)] trên 'abc' phải ra ['ab', 'c'], bạn ra {got}. Merge nào được áp trước?"
    got = enc("abc", [("b", "c"), ("a", "b")])
    assert got == ["a", "bc"], f"Bảng [(b,c), (a,b)] trên 'abc' phải ra ['a', 'bc'], bạn ra {got}."
    got = enc("abc", [("a", "b"), ("ab", "c")])
    assert got == ["abc"], f"Merge ('ab','c') chỉ có tác dụng sau khi ('a','b') đã tạo token 'ab': cần ['abc'], bạn ra {got}."
    got = enc("abc", [("ab", "c"), ("a", "b")])
    assert got == ["ab", "c"], f"Merge ('ab','c') đứng trước ('a','b') thì chưa có token 'ab' để gộp: cần ['ab', 'c'], bạn ra {got}."


def test_overlap(user, ref):
    """Cặp chồng lấn ('aaa'): thay từ trái sang phải, không dùng một ký tự hai lần"""
    enc = need(user, "encode")
    for text, want in [("aaa", ["aa", "a"]), ("aaaa", ["aa", "aa"]), ("aaaaa", ["aa", "aa", "a"])]:
        got = enc(text, [("a", "a")])
        assert got == want, f"encode({text!r}, [('a','a')]) ra {got}, cần {want}."
    got = enc("aaaaa", [("a", "a"), ("aa", "a")])
    assert got == ["aa", "aaa"], f"Bảng [(a,a), (aa,a)] trên 'aaaaa': sau merge đầu là ['aa','aa','a'], merge thứ hai quét lại từ đầu; bạn ra {got}, cần ['aa', 'aaa']."


def test_learned_table(user, ref):
    """Bảng học từ một văn bản thật: khớp lời giải chuẩn, và chuỗi ngắn đi"""
    enc = need(user, "encode")
    merges = _table(ref, 12)
    for text in [CORPUS, "lower newest xin", "lowest widest viet nam"]:
        got, want = enc(text, merges), ref["encode"](text, merges)
        assert got == want, f"encode({text!r}) lệch lời giải chuẩn: bạn ra {got[:8]}…, cần {want[:8]}…"
    assert len(enc(CORPUS, merges)) < len(CORPUS) - 20, "Sau 12 merge học từ chính văn bản này, số token phải ít hơn số ký tự ít nhất 20: có merge nào chưa được áp không?"


def test_unknown_characters(user, ref):
    """Ký tự chưa từng thấy (emoji, chữ có dấu, xuống dòng) vẫn thành token riêng"""
    enc = need(user, "encode")
    got = enc("x✓ab\né", [("a", "b")])
    assert got == ["x", "✓", "ab", "\n", "é"], f"Ký tự lạ bị mất hoặc gộp sai: bạn ra {got}."
    got = enc("zzz", [("a", "b")])
    assert got == ["z", "z", "z"], f"Văn bản không có cặp nào trong bảng phải giữ nguyên từng ký tự; bạn ra {got}."


def test_empty(user, ref):
    """Chuỗi rỗng và bảng merge rỗng"""
    enc, dec = need(user, "encode"), need(user, "decode")
    assert enc("", [("a", "b")]) == [], "encode('', merges) phải là []."
    assert enc("", []) == [], "encode('', []) phải là []."
    assert enc("abc", []) == ["a", "b", "c"], f"Bảng rỗng thì mỗi ký tự là một token; bạn ra {enc('abc', [])}."
    assert dec([]) == "", "decode([]) phải là chuỗi rỗng ''."
    assert isinstance(dec([]), str), "decode phải trả về str."


def test_roundtrip(user, ref):
    """decode(encode(x)) == x với văn bản ngẫu nhiên, có ký tự lạ, với nhiều bảng merge"""
    enc, dec = need(user, "encode"), need(user, "decode")
    rng = random.Random(0)
    alphabet = "abc de\nxyé✓"
    tables = [[], _table(ref, 3), _table(ref, 30), [("a", "a"), ("aa", "aa"), ("b", "c")]]
    for merges in tables:
        for _ in range(25):
            text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 40)))
            toks = enc(text, merges)
            assert isinstance(toks, list) and all(isinstance(x, str) for x in toks), f"encode phải trả về list các str; bạn trả về {toks!r}."
            back = dec(toks)
            assert back == text, f"decode(encode({text!r})) ra {back!r}: encode hoặc decode đang làm mất hay thêm ký tự."
            assert toks == ref["encode"](text, merges), f"encode({text!r}) ra {toks}, lời giải chuẩn ra {ref['encode'](text, merges)}."


def test_pure(user, ref):
    """Không sửa bảng merge đầu vào; gọi hai lần cho cùng kết quả"""
    enc = need(user, "encode")
    merges = [("a", "b"), ("ab", "c"), ("c", "c")]
    snapshot = list(merges)
    first = enc("abcabccc", merges)
    assert merges == snapshot, "encode đã sửa danh sách merges (pop, sort, remove…): người gọi còn cần nó cho lần sau."
    assert enc("abcabccc", merges) == first, "Gọi encode hai lần với cùng đầu vào ra hai kết quả khác nhau."
    assert first == ["abc", "abc", "cc"], f"encode('abcabccc') ra {first}, cần ['abc', 'abc', 'cc']."
