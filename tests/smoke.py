#!/usr/bin/env python3
"""정적 블로그 스모크 테스트 — 빌드 도구 없이 python3 tests/smoke.py 로 돌린다.

점검 항목:
  1. 필수 파일 존재
  2. posts.json JSON 파싱 + posts/*.md 대응 확인
  3. index.html 의 에셋 참조(쿼리 버전 일치) 확인
  4. 태그 키가 app.js TAGS 및 admin.js 기본값과 일치
  5. 민감어 0건 스캔 (공개 페이지가 될 파일 대상)
  6. app.js 가 예전 globals(renderMarkdown, TAGS)를 그대로 노출하는지(관리자 미리보기 호환)
  7. 모바일 레이아웃 회귀(검색창 높이·히어로 여백)
  8. 2026-11-18 디자인 정리 스펙(샬레·히어로 버튼·히어로 그림·평행사변형 0건, 새 히어로 문구)
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

REQUIRED = ["index.html", "style.css", "app.js", "admin.js", "posts.json",
            "robots.txt", "sitemap.xml", "404.html", "site-config.json",
            ".nojekyll", "assets/favicon.svg"]

# 공개 사이트에 실려 나가면 안 되는 단어 (sync_notion.py 의 목록과 같은 성격)
SENSITIVE = [
    "군대", "군인", "부대", "훈련소", "입대", "제대하", "제대한", "전역", "간부",
    "병장", "상병", "일병", "이병", "영창", "국가정보원",
]
# 본문(글)에만 점검하는 인증정보 단어 — admin.js 는 토큰 입력 UI 자체라 예외
CRED_WORDS = ["password", "secret_", "github_pat_"]

failures = []


def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


# 1. 필수 파일
for rel in REQUIRED:
    check(f"파일 존재: {rel}", (ROOT / rel).exists())

# 2. posts.json
try:
    posts = json.loads((ROOT / "posts.json").read_text(encoding="utf-8"))
    check("posts.json 파싱", True)
except Exception as e:
    posts = []
    check("posts.json 파싱", False, str(e))

slugs = [p["slug"] for p in posts]
check("slug 고유", len(slugs) == len(set(slugs)))
for p in posts:
    f = ROOT / "posts" / f"{p['slug']}.md"
    check(f"글 본문 존재: {p['slug']}", f.exists())
    for key in ("slug", "title", "date", "tags"):
        check(f"필수 키 {key}: {p['slug']}", key in p)
    if p.get("cover"):
        cover_rel = str(p["cover"]).lstrip("./")
        check(f"cover 파일 존재: {p['slug']}", (ROOT / cover_rel).exists(), str(p["cover"]))

# 고아 항목(본문 없는 카드) 0건 — 목록에만 남아 404로 가는 카드
for slug in slugs:
    check(f"목록↔본문 짝: {slug}", (ROOT / "posts" / f"{slug}.md").exists())

# 3. index.html 참조
html = (ROOT / "index.html").read_text(encoding="utf-8")
versions = set(re.findall(r'\?v=([a-z0-9]+)', html))
check("에셋 버전 쿼리 하나로 통일", len(versions) == 1, ",".join(versions))
for asset in re.findall(r'(?:href|src)="\./([^"]+)\?v=', html):
    check(f"참조 파일 존재: {asset}", (ROOT / asset).exists())
check("canonical 설정", "https://jeonsul.github.io/" in html)
check("robots/sitemap 연결", "sitemap.xml" in (ROOT / "robots.txt").read_text(encoding="utf-8"))

# 4. 태그 일치
app_js = (ROOT / "app.js").read_text(encoding="utf-8")
m = re.search(r"const TAGS = \{([^}]*)\}", app_js)
check("app.js TAGS 블록", bool(m))
if m:
    app_tags = set(re.findall(r"(\w+):", m.group(1)))
    json_tags = {t for p in posts for t in p.get("tags", [])}
    check("posts.json 태그가 TAGS 안에 있음", json_tags <= app_tags, f"{json_tags - app_tags}")

# 5. 민감어 스캔 (노출 파일 대상, 대소문자 무시)
scan_targets = [ROOT / f for f in REQUIRED if f.endswith((".html", ".js", ".json", ".xml", ".txt", ".svg"))]
scan_targets += [ROOT / "posts" / f"{p['slug']}.md" for p in posts]
for f in scan_targets:
    text = f.read_text(encoding="utf-8", errors="replace").lower()
    hits = [w for w in SENSITIVE if w in text]
    check(f"민감어 0건: {f.name}", not hits, ",".join(hits))

for p in posts:
    f = ROOT / "posts" / f"{p['slug']}.md"
    text = f.read_text(encoding="utf-8", errors="replace").lower()
    hits = [w for w in CRED_WORDS if w in text]
    check(f"인증정보 0건: {f.name}", not hits, ",".join(hits))

# 6. 관리자 호환 globals
check("app.js renderMarkdown 노출", "function renderMarkdown" in app_js)
check("app.js GoatCounter 검증 유지", "GOATCOUNT RE" in app_js.replace(" ", "").replace("RE\"", "RE\"") or "GOATCOUNTER_RE" in app_js)
check("admin.js 관리자 화면 유지", "BlogAdmin" in app_js and "BlogAdmin" in (ROOT / "admin.js").read_text(encoding="utf-8"))

# 7. 모바일 레이아웃 회귀 방지 — column flex에서 검색창이 240px 높이로 늘어나던 버그
css = (ROOT / "style.css").read_text(encoding="utf-8")
box = re.search(r"\.search-box \{([^}]*)\}", css)
check("검색창 height 고정", bool(box) and "height: 2.75rem" in box.group(1))
check("검색 입력창 height 100%", re.search(r"\.search-box input \{[^}]*height: 100%", css) is not None)

mobile = re.search(r"@media \(max-width: 720px\) \{(.*?)\n\}", css, re.S)
block = mobile.group(1) if mobile else ""
check("모바일 검색창 flex: 0 0 auto", re.search(r"\.search-box \{[^}]*flex: 0 0 auto", block) is not None)
check("모바일 검색창 폭 100%", re.search(r"\.search-box \{[^}]*width: 100%", block) is not None)
check("모바일 검색창 max-width 해제", re.search(r"\.search-box \{[^}]*max-width: none", block) is not None)
check("모바일 히어로 여백 컴팩트", re.search(r"\.hero \{[^}]*padding: 1rem 0 1\.05rem", block) is not None, block[:120])
check("모바일 히어로 제목 크기 제한", re.search(r"\.hero h1 \{[^}]*clamp\(1\.5rem, 6\.6vw, 1\.8rem\)", block) is not None)
check("모바일 히어로 그림 없음", ".hero-art" not in block)
check("터치 기기 '/' 배지 숨김",
      re.search(r"@media \(max-width: 860px\), \(hover: none\) \{[^}]*\.search-kbd \{ display: none; \}", css) is not None)
foot = re.search(r"\.site-footer \{([^}]*)\}", css)
check("푸터 safe-area 여백", bool(foot) and "env(safe-area-inset-bottom" in foot.group(1))

# 8. 2026-11-18 디자인 정리 — 샬레·히어로 버튼·히어로 그림·평행사변형 제거
html_all = html + (ROOT / "404.html").read_text(encoding="utf-8")
favicon = (ROOT / "assets" / "favicon.svg").read_text(encoding="utf-8")
app_js = (ROOT / "app.js").read_text(encoding="utf-8")
pages = app_js + css + html_all + favicon

check("토스 블루 잔재 없음", "#3182F6" not in css and "#3182f6" not in html.lower())
check("시그니처 블루 유지", "#128afa" in css.lower())
check("야간 팔레트 유지", "#0b131f" in css.lower() and "#38b6ff" in css.lower())
check("평행사변형(skewX) 0건", "skewx" not in css.lower() and "skewx" not in html_all.lower(), ", ".join(
    [n for n, t in (("style.css", css), ("404.html", html_all)) if "skewx" in t.lower()]))
check("기울임 역보정(skew) 잔재 0건", "skew" not in css.lower() and "skew" not in html_all.lower())
check("샬레 흔적 0건", not any(w in pages for w in ("S.C.H.A.L.E", "SCHALE", "샬레")))
check("키보토스 흔적 0건", "키보토스" not in pages)
check("히어로 상태 바 제거", "hero-bar" not in app_js and "hero-bar" not in css and "data-stat" not in app_js)
check("히어로 버튼 제거", "최근 글 읽기" not in app_js and "소개 보기" not in app_js and "hero-cta" not in css and "hero-cta" not in app_js)
check("히어로 그림 제거", "hero-art" not in app_js and "hero-art" not in css and "heroArtSvg" not in app_js)
check("히어로 헬퍼 정리", "heroBarHtml" not in app_js and "fillHeroStats" not in app_js and "haloMarkSvg" not in app_js)
check("히어로 새 문구 — 눈썹", "기록 · 2026 · 전설 아카이브" in app_js)
check("히어로 새 문구 — 제목", "전설 아카이브,<br><em>그 이상을 적습니다</em>." in app_js)
check("히어로 부제 한 줄", "인공지능을 공부하고, 사진을 찍고, 음악을 모으는 사람의 기록." in app_js)
check("파비콘 라벨", "전설 아카이브" in favicon)
check("404 브랜드 라벨", "전설 아카이브" in html_all and "SCHALE" not in html_all)
# 9. 2026-11-18 JK 아이콘 — 파비콘·홈화면 아이콘·헤더 마크
assets = ROOT / "assets"
icon192 = assets / "icon-192.png"
apple = assets / "apple-touch-icon.png"
check("파비콘 64 뷰박스", 'viewBox="0 0 64 64"' in favicon)
check("파비콘 글자 outline", favicon.count('fill="#FFFFFF" stroke="#FFFFFF"') == 2 and '<g transform="translate(' in favicon)
check("파비콘에 text 태그 없음", "<text" not in favicon)
check("파비콘 별빛", "#0B84FF" in favicon and "linearGradient" in favicon)
check("파비콘 딥블랙", "#131416" in favicon or "#15171A" in favicon)
check("icon-192.png 존재", icon192.is_file() and icon192.stat().st_size > 2000, str(icon192))
check("apple-touch-icon.png 존재", apple.is_file() and apple.stat().st_size > 2000, str(apple))
check("index 아이콘 링크 3종", html.count('rel="icon"') == 2 and "apple-touch-icon" in html and "icon-192.png" in html)
check("헤더 마크 교체", "bm-sp" in html and re.search(r'<svg viewBox="7?\.?\d+ .*?" aria-hidden="true" focusable="false">', html) is not None
      and html.count('stroke="#FFFFFF"') == 2)
check("헤더 마크 옛 헤일로 제거", "ellipse" not in html)
check("404 아이콘 링크", "apple-touch-icon" in html_all and "m-sp" in html_all)
check("버튼 둥근 사각형", "--radius-btn: 10px" in css)
check("알약형 태그 필터", re.search(r"\.seg-item::before \{[^}]*border-radius: 999px", css) is not None)
check("모서리 잘라내기(clip-path 차단) 0건", "polygon(" not in css and "polygon(" not in html_all)
check("카드 대표 사진 프레임", ".card-cover" in css and "aspect-ratio" in css)
check("댓글 지연 로드", "IntersectionObserver" in app_js and "requestComments" in app_js)
check("카드 content-visibility", "content-visibility: auto" in css)
check("테마색 갱신", "#0B131F" in app_js and "#EDF5FC" in app_js)

print()
if failures:
    print(f"{len(failures)}개 실패: {failures}")
    sys.exit(1)
print("모든 스모크 테스트 통과 ✓")
