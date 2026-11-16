# 전국 · 기록

개인 블로그. 빌드 도구 없이 도는 정적 사이트입니다 — GitHub Pages에서 `main` 브랜치 루트를 그대로 서빙합니다.

- 주소: https://jeonsul.github.io/Jeonsul.github.io-/
- 저장소: https://github.com/Jeonsul/Jeonsul.github.io-

## 구성

```
index.html      화면 틀 (헤더 · 본문 · 푸터)
style.css       전체 스타일 (라이트/다크 토큰, 타이포그래피, 반응형)
app.js          해시 라우터 · 마크다운 렌더러 · 테마 전환
posts.json      글 목록 (제목, 요약, 날짜, 태그)
posts/*.md      글 본문 (마크다운)
assets/         파비콘
404.html        없는 주소 안내
sync_notion.py  노션에서 '공개' 글만 가져오는 도우미
```

## 글 쓰는 법

1. `posts/`에 마크다운 파일을 하나 만듭니다. 파일명이 주소가 됩니다. 예: `posts/my-first-run.md` → `#/post/my-first-run`
2. `posts.json` 맨 위에 항목을 추가합니다.

```json
{
  "slug": "my-first-run",
  "title": "첫 10km",
  "summary": "목록에 보일 한두 문장 요약.",
  "date": "2026-11-20",
  "tags": ["life"]
}
```

3. 커밋하고 푸시하면 1분 안에 반영됩니다.

태그는 `ai`(AI·개발), `music`(음악), `photo`(사진), `life`(일상) 네 가지를 씁니다. 새 태그를 쓰려면 `app.js` 맨 위 `TAGS`에 한 줄 추가하세요.

## 로컬에서 보기

`fetch`로 글을 읽기 때문에 `index.html`을 그냥 열면 목록이 비어 보입니다. 폴더에서 서버를 하나 띄우세요.

```bash
python3 -m http.server 8000
# http://localhost:8000
```

## 노션에서 가져오기

`sync_notion.py`는 데이터베이스에서 **'공개' 체크박스가 켜진 글만** 내보냅니다. 기본값은 꺼짐이고, 제목·본문에 민감한 단어가 있으면 내보내지 않고 알려 줍니다.

```bash
export NOTION_TOKEN=secret_xxx          # 노션 integration 토큰
python3 sync_notion.py --db <DB_ID>     # 미리보기
python3 sync_notion.py --db <DB_ID> --write   # 실제 반영
```

미리보기 결과에서 `+`는 올라갈 글, `!`는 민감어로 막힌 글, `-`는 공개 체크가 꺼진 글입니다.

## 배포

Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)`.

`.github/workflows`는 쓰지 않습니다. 모든 파일을 그대로 서빙하므로 빌드가 실패할 일이 없습니다.
