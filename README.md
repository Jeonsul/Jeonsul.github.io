# 전국 · 기록

개인 블로그. 빌드 도구 없이 도는 정적 사이트입니다 — GitHub Pages에서 `main` 브랜치 루트를 그대로 서빙합니다.

- 주소: https://jeonsul.github.io/
- 저장소: https://github.com/Jeonsul/Jeonsul.github.io

## 구성

```
index.html      화면 틀 (헤더 · 본문 · 푸터)
style.css       전체 스타일 (라이트/다크 토큰, 타이포그래피, 반응형, 관리자 화면)
app.js          해시 라우터 · 마크다운 렌더러 · 테마 전환 · 방문자 통계 훅
admin.js        관리자 모드 (#/admin) — GitHub API로 글쓰기/수정/삭제
site-config.json 방문자 통계 설정 (GoatCounter 코드)
posts.json      글 목록 (제목, 요약, 날짜, 태그)
posts/*.md      글 본문 (마크다운)
assets/         파비콘
404.html        없는 주소 안내
sync_notion.py  노션에서 '공개' 글만 가져오는 도우미
```

## 관리자 모드로 글 쓰기

브라우저에서 https://jeonsul.github.io/#/admin 을 엽니다. 푸터의 `관리` 링크로도 들어갈 수 있습니다.

1. GitHub **Fine-grained Personal Access Token**을 하나 만듭니다.
   - Repository access: `Only select repositories` → **Jeonsul.github.io**
   - Permissions → Repository permissions → **Contents: Read and write**
2. `#/admin` 로그인 칸에 토큰을 붙여 넣습니다. 토큰마다 `GET /user`와 `GET /repos/Jeonsul/Jeonsul.github.io`로 쓰기 권한(`permissions.push`)을 확인한 뒤에만 관리자 화면이 열립니다.
3. 글을 쓰고 **게시**를 누르면 `posts/{슬러그}.md`와 `posts.json`이 GitHub Contents API로 커밋됩니다. 반영까지 30초~1분 걸립니다.

- 토큰은 이 브라우저에만 저장됩니다(`이 기기에 로그인 유지` 체크 시 `localStorage`, 해제 시 `sessionStorage`). 저장소 파일에는 절대 기록하지 않습니다.
- 쓰는 중인 내용은 0.5초 간격으로 `localStorage`에 임시저장되고, 다시 열면 복원할지 물어봅니다.
- 슬러그는 영문 소문자·숫자·하이픈만 씁니다. 예: `hello-world` → `#/post/hello-world`
- 슬러그를 바꾸면 새 파일을 만들고 예전 `posts/{옛슬러그}.md`는 지운 뒤 `posts.json`을 갱신합니다.
- 삭제는 확인 창을 한 번 거친 뒤 `posts/{슬러그}.md`와 `posts.json` 항목을 함께 지웁니다.

토큰을 잃어버리면 GitHub에서 지우고 새로 만들면 됩니다.

## 방문자 통계 (GoatCounter)

[GoatCounter](https://www.goatcounter.com/)는 무료·쿠키 없는 방문자 통계입니다.

1. goatcounter.com에서 가입하고 사이트 코드(예: `jeonsul`)를 정합니다.
2. `site-config.json`의 `goatcounterCode`를 채웁니다. `#/admin` 방문자 통계 카드의 입력칸에서 저장해도 바로 커밋됩니다.

```json
{
  "goatcounterCode": "jeonsul"
}
```

3. GoatCounter **Settings → Visitor counter**에서 **Allow adding visitor counts on your website**를 켜고, **Site's Domain**에 `jeonsul.github.io`를 넣습니다. 이 두 가지가 되어 있어야 `#/admin`에 숫자가 뜹니다.

코드가 채워지면 `app.js`가 `https://gc.zgo.at/count.js`를 불러오고, 해시 라우팅으로 화면이 바뀔 때마다 `window.goatcounter.count({ path: location.hash || '#/' })`로 조회수를 기록합니다. `#/admin` 화면은 집계에서 뺍니다.

`#/admin`의 방문자 통계 카드는 `https://{코드}.goatcounter.com/counter/TOTAL.json`과 글별 `counter/{#/post/슬러그}.json`을 읽어 전체 방문과 글별 조회수를 보여 주고, 대시보드 바로가기를 제공합니다. GoatCounter 응답은 최대 4시간 캐시되므로 숫자가 조금 늦게 바뀝니다.

## 손으로 글 쓰기

관리자 화면 없이 파일로 직접 써도 됩니다.

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

로컬 주소는 `#/admin` 로그인 검증(GitHub API)까지는 되지만, GoatCounter는 설정한 도메인에서만 집계합니다.

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
