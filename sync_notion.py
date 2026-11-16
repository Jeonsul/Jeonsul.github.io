#!/usr/bin/env python3
"""
sync_notion.py — 노션에서 '공개'로 표시한 페이지만 블로그 글로 가져오는 도우미.

기본은 미리보기(dry-run)입니다. 실제로 파일을 쓰려면 --write 를 붙이세요.

    # 1) 미리보기: 어떤 글이 올라갈지, 어떤 글이 걸러지는지 먼저 확인
    NOTION_TOKEN=secret_xxx python3 sync_notion.py --db <데이터베이스ID>

    # 2) 실제 반영 (posts/*.md + posts.json)
    NOTION_TOKEN=secret_xxx python3 sync_notion.py --db <데이터베이스ID> --write

안전 규칙 (중요)
  1. 데이터베이스의 '공개' 체크박스가 켜진 페이지만 내보냅니다. 기본값은 '꺼짐'입니다.
  2. 제목이나 본문에 아래 BLOCKED_WORDS 중 하나라도 있으면 내보내지 않고 건너뜁니다.
     걸러진 글은 목록으로 보고되니, 정말 공개해도 되는 글인지 직접 확인하세요.
  3. 기존 글 파일은 지우지 않습니다. 이 스크립트가 만든 글(source: notion)만 갱신합니다.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime

NOTION_VERSION = "2022-06-28"
API = "https://api.notion.com/v1"

# 공개하면 안 되는 내용의 신호. 하나라도 걸리면 그 글은 내보내지 않습니다.
# (일상 단어와 겹칠 수 있으므로 '걸리면 사람이 확인'이 기본 동작입니다.)
BLOCKED_WORDS = [
    "군대", "군생활", "군인", "부대", "전역", "입대", "제대", "복무", "병사", "장병",
    "상병", "일병", "병장", "이병", "소대", "중대", "대대", "사단", "여단", "연대",
    "초소", "당직", "경계", "근무", "불출", "연등", "GOP", "GP", "사격", "훈련",
    "휴가", "외박", "외출", "동기", "선임", "후임", "관사", "막사", "생활관",
]


# ── 노션 API ──────────────────────────────────────────────────────────────

def notion(path, method="GET", payload=None, token=None):
    url = f"{API}/{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Notion-Version", NOTION_VERSION)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise SystemExit(f"노션 API 오류 {e.code}: {body[:400]}")


def query_database(db_id, token):
    pages, cursor = [], None
    while True:
        payload = {"page_size": 100}
        if cursor:
            payload["start_cursor"] = cursor
        res = notion(f"databases/{db_id}/query", "POST", payload, token)
        pages.extend(res.get("results", []))
        if not res.get("has_more"):
            return pages
        cursor = res.get("next_cursor")


def fetch_blocks(block_id, token, depth=0):
    if depth > 6:
        return []
    blocks, cursor = [], None
    while True:
        q = f"blocks/{block_id}/children?page_size=100"
        if cursor:
            q += f"&start_cursor={cursor}"
        res = notion(q, token=token)
        blocks.extend(res.get("results", []))
        if not res.get("has_more"):
            break
        cursor = res.get("next_cursor")
    out = []
    for b in blocks:
        out.append(b)
        if b.get("has_children") and b.get("type") in ("bulleted_list_item", "numbered_list_item", "toggle", "callout"):
            b["_children"] = fetch_blocks(b["id"], token, depth + 1)
    return out


# ── 값 꺼내기 ─────────────────────────────────────────────────────────────

def rich_text(rt):
    return "".join(t.get("plain_text", "") for t in rt or [])


def prop_text(page, name):
    p = page.get("properties", {}).get(name)
    if not p:
        return ""
    kind = p.get("type")
    if kind == "title":
        return rich_text(p.get("title"))
    if kind == "rich_text":
        return rich_text(p.get("rich_text"))
    if kind == "checkbox":
        return p.get("checkbox", False)
    if kind == "select":
        return (p.get("select") or {}).get("name", "")
    if kind == "multi_select":
        return [x.get("name", "") for x in p.get("multi_select", [])]
    if kind == "date":
        d = p.get("date") or {}
        return d.get("start", "")
    return ""


def blocks_to_md(blocks):
    lines = []
    for b in blocks:
        t = b.get("type")
        data = b.get(t, {}) or {}
        text = rich_text(data.get("rich_text"))

        if t == "paragraph":
            lines.append(text)
        elif t in ("heading_1", "heading_2", "heading_3"):
            level = {"heading_1": "##", "heading_2": "##", "heading_3": "###"}[t]
            lines.append(f"{level} {text}")
        elif t == "bulleted_list_item":
            lines.append(f"- {text}")
        elif t == "numbered_list_item":
            lines.append(f"1. {text}")
        elif t == "quote":
            lines.append(f"> {text}")
        elif t == "callout":
            lines.append(f"> {text}")
        elif t == "divider":
            lines.append("---")
        elif t == "code":
            lang = data.get("language", "") or ""
            lines.append(f"```{lang}\n{text}\n```")
        elif t == "image":
            src = data.get("external", {}).get("url") or ""
            if data.get("type") == "file":
                src = data.get("file", {}).get("url", "")
            lines.append(f"![{text or '이미지'}]({src})")
        else:
            if text:
                lines.append(text)

        lines.append("")
    return "\n".join(lines).strip() + "\n"


def slugify(title, fallback):
    s = title.strip().lower()
    s = re.sub(r"[^a-z0-9가-힣\s-]", "", s)
    s = re.sub(r"\s+", "-", s).strip("-")
    s = s[:40].strip("-")
    if not s or re.search(r"[가-힣]", s):
        # 한글 제목은 URL에 그대로 쓰기 어려우니 날짜 기반 주소를 씁니다.
        return fallback
    return s


# ── 메인 ─────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="노션 '공개' 글만 블로그로 가져오기")
    ap.add_argument("--db", default=os.environ.get("NOTION_DB", ""), help="노션 데이터베이스 ID")
    ap.add_argument("--root", default=".", help="블로그 폴더 (기본: 현재 폴더)")
    ap.add_argument("--public-prop", default="공개", help="공개 여부 체크박스 속성 이름 (기본: 공개)")
    ap.add_argument("--tag-prop", default="태그", help="태그 속성 이름 (기본: 태그)")
    ap.add_argument("--write", action="store_true", help="실제로 파일을 씁니다 (없으면 미리보기)")
    args = ap.parse_args()

    token = os.environ.get("NOTION_TOKEN", "")
    if not token:
        raise SystemExit("NOTION_TOKEN 환경변수가 필요합니다.")
    if not args.db:
        raise SystemExit("--db 또는 NOTION_DB 환경변수로 데이터베이스 ID를 지정하세요.")

    posts_dir = os.path.join(args.root, "posts")
    index_path = os.path.join(args.root, "posts.json")
    os.makedirs(posts_dir, exist_ok=True)

    index = []
    if os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as f:
            index = json.load(f)

    pages = query_database(args.db, token)
    published, blocked, skipped = [], [], []

    for page in pages:
        title = prop_text(page, "이름") or prop_text(page, "제목") or prop_text(page, "Title") or "제목 없음"
        public = prop_text(page, args.public_prop)
        date = prop_text(page, "날짜") or prop_text(page, "Date") or page.get("created_time", "")[:10]
        date = (date or datetime.now().strftime("%Y-%m-%d"))[:10]
        tags = prop_text(page, args.tag_prop)
        if isinstance(tags, str):
            tags = [tags] if tags else []

        if public is not True:
            skipped.append((title, "공개 체크 안 됨"))
            continue

        body = blocks_to_md(fetch_blocks(page["id"], token))
        haystack = f"{title}\n{body}"

        hit = [w for w in BLOCKED_WORDS if w in haystack]
        if hit:
            blocked.append((title, ", ".join(sorted(set(hit)))))
            continue

        slug = slugify(title, f"note-{date.replace('-', '')}-{page['id'][-4:]}")
        summary = re.sub(r"\s+", " ", body.replace("#", ""))[:110].strip()
        entry = {
            "slug": slug,
            "title": title,
            "summary": summary,
            "date": date,
            "tags": [t for t in tags if t] or ["life"],
            "source": "notion",
            "notion_id": page["id"],
        }
        published.append((entry, body))

    # ── 보고 ──
    mode = "반영" if args.write else "미리보기 (파일을 쓰지 않았습니다. --write 로 반영)"
    print(f"\n[{mode}] 공개 대상 {len(published)}편 / 제외 {len(skipped)}편 / 민감어 차단 {len(blocked)}편\n")
    for entry, _ in published:
        print(f"  + {entry['date']}  {entry['title']}  -> posts/{entry['slug']}.md")
    for title, why in blocked:
        print(f"  ! 차단됨: {title}  ({why}) — 직접 확인 후 필요하면 손으로 작성하세요.")
    for title, why in skipped:
        print(f"  - 건너뜀: {title}  ({why})")

    if not args.write:
        print("\n미리보기만 했습니다. 위 내용이 맞으면 --write 를 붙여 다시 실행하세요.")
        return

    for entry, body in published:
        with open(os.path.join(posts_dir, f"{entry['slug']}.md"), "w", encoding="utf-8") as f:
            f.write(body)

    # posts.json: 이 스크립트가 만든 항목만 갱신하고, 손으로 쓴 글은 그대로 둡니다.
    by_slug = {p["slug"]: p for p in index}
    for entry, _ in published:
        by_slug[entry["slug"]] = entry
    merged = sorted(by_slug.values(), key=lambda p: p.get("date", ""), reverse=True)
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"\n완료: 글 {len(published)}편 반영, posts.json 갱신.")
    print("확인 후 커밋하세요: git add -A && git commit -m \"글 추가\" && git push")


if __name__ == "__main__":
    sys.exit(main())
