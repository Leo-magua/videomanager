#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
依赖: pip install requests beautifulsoup4
"""

import re
import sys
import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

BASE = "https://cili.uk"
# 用法: python magnets.py <搜索关键词>
QUERY = sys.argv[1] if len(sys.argv) > 1 else ""
SEARCH_URL = f"{BASE}/search?q={QUERY}"
OUT_FILE = f"{QUERY}_magnets.txt"

SESSION = requests.Session()
SESSION.headers.update(
    {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
)


def main():
    if not QUERY:
        raise SystemExit("用法: python magnets.py <搜索关键词>")

    r = SESSION.get(SEARCH_URL, timeout=30)
    r.raise_for_status()

    soup = BeautifulSoup(r.text, "html.parser")
    table = soup.select_one("table.file-list")
    if not table:
        raise RuntimeError("未找到 table.file-list，页面结构可能已变或被拦截")

    detail_urls = []
    for a in table.select("a[href]"):
        href = (a.get("href") or "").strip()
        if re.match(r"^/![^/]+$", href):
            detail_urls.append(urljoin(BASE, href))

    # 去重且保持顺序
    seen = set()
    unique_urls = []
    for u in detail_urls:
        if u not in seen:
            seen.add(u)
            unique_urls.append(u)

    magnets = []
    for url in unique_urls:
        time.sleep(0.8)  # 轻微限速，避免请求过快
        rr = SESSION.get(url, timeout=30)
        rr.raise_for_status()
        ss = BeautifulSoup(rr.text, "html.parser")
        inp = ss.find(id="input-magnet")
        val = inp.get("value") if inp else None
        if val:
            magnets.append(val.strip())
        else:
            print(f"[warn] 未找到 magnet: {url}")

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(magnets))

    print(f"共写入 {len(magnets)} 条到 {OUT_FILE}")


if __name__ == "__main__":
    main()