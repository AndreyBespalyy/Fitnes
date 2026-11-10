"""Доля слов с ошибкой (WER) — метрика качества распознавания из ТЗ (цель ≤ 15 % на звонках клуба).
Использование: python -m app.wer эталон.txt расшифровка.txt  (или две папки с одинаковыми именами файлов)."""

from __future__ import annotations

import re
import sys
from pathlib import Path


def words(s: str) -> list[str]:
    return re.findall(r"[\wё]+", s.lower().replace("ё", "е"))


def wer(ref: str, hyp: str) -> float:
    r, h = words(ref), words(hyp)
    if not r:
        return 0.0 if not h else 1.0
    prev = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        cur = [i] + [0] * len(h)
        for j in range(1, len(h) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] != h[j - 1]))
        prev = cur
    return prev[-1] / len(r)


def main(a: str, b: str) -> None:
    pa, pb = Path(a), Path(b)
    pairs = [(f, pb / f.name) for f in sorted(pa.glob("*.txt"))] if pa.is_dir() else [(pa, pb)]
    total_err = total_words = 0
    for ref, hyp in pairs:
        if not hyp.exists():
            print(f"{ref.name}: нет расшифровки")
            continue
        rt = ref.read_text(encoding="utf-8")
        e = wer(rt, hyp.read_text(encoding="utf-8"))
        n = len(words(rt))
        total_err += e * n
        total_words += n
        print(f"{ref.name}: WER {e * 100:.1f} %")
    if total_words:
        print(f"Итого: WER {total_err / total_words * 100:.1f} % на {total_words} словах (цель ≤ 15 %)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
