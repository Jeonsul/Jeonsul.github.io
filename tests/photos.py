#!/usr/bin/env python3
"""사진 업로드 · 댓글(Disqus) 기능 테스트 — python3 tests/photos.py

이 환경에는 node가 없고 quickjs만 있어서, 브라우저 대신 최소 DOM 스텁을
붙인 quickjs 위에서 app.js / admin.js를 실제로 실행해 확인한다.

점검 항목:
  1. JS 문법 (app.js, admin.js)
  2. 사진 마크다운 렌더링 (figure · 캡션 · 인라인 · 이스케이프 · 지연 로딩)
  3. 라이트박스 준비 (함수 존재, placeholder alt 판정)
  4. 업로드 유틸 (파일 이름 · 경로 · base64 · 마크다운)
  5. 해시뱅 라우팅 (#!post/... · ?post=) — Disqus 알림 링크 대응
  6. Disqus 설정 (식별자 · 주소 · shortname 검증) · site-config 보존
  7. style.css의 사진/라이트박스/댓글 스타일과 캐시 버전
"""

import json
import re
import sys
from pathlib import Path

import quickjs

ROOT = Path(__file__).resolve().parent.parent

failures = []


def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


# ── 실행 환경(최소 DOM 스텁) ───────────────────────────────────────
PRELUDE = r"""
var __els = {};
function __el(key) {
  if (__els[key]) return __els[key];
  var el = {
    id: key, innerHTML: '', textContent: '', title: '', dataset: {}, style: {},
    hidden: false, className: '', children: [], parentNode: null,
    classList: {
      _s: {},
      add: function (c) { this._s[c] = 1; },
      remove: function (c) { delete this._s[c]; },
      contains: function (c) { return !!this._s[c]; },
      toggle: function (c, v) {
        var on = v === undefined ? !this._s[c] : !!v;
        if (on) this._s[c] = 1; else delete this._s[c];
        return on;
      }
    },
    setAttribute: function () {}, getAttribute: function () { return null; },
    removeAttribute: function () {}, addEventListener: function () {},
    removeEventListener: function () {}, appendChild: function () {},
    insertBefore: function () {}, remove: function () {}, after: function () {},
    before: function () {}, replaceWith: function () {}, focus: function () {},
    blur: function () {}, closest: function () { return null; },
    querySelector: function () { return __el(key + ':sub'); },
    querySelectorAll: function () { return []; },
    scrollLeft: 0, scrollWidth: 0
  };
  __els[key] = el;
  return el;
}
var window = globalThis;
window.addEventListener = function () {};
window.removeEventListener = function () {};
window.scrollTo = function () {};
window.matchMedia = null;
var document = {
  documentElement: { dataset: { theme: 'light' } },
  body: __el('body'),
  head: __el('head'),
  title: '',
  getElementById: function (id) {
    return ['main', 'siteHeader', 'progress', 'year'].indexOf(id) >= 0 ? __el(id) : null;
  },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  createElement: function (tag) { return __el('new:' + tag + ':' + Math.random()); },
  addEventListener: function () {}
};
var localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
var sessionStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
var location = { hash: '#/', search: '', href: 'https://jeonsul.github.io/' };
var navigator = { clipboard: { writeText: function () { return Promise.resolve(); } } };
function fetch() { return Promise.reject(new Error('offline-test')); }
/* quickjs에는 btoa/atob이 없다 — 브라우저와 같은 동작을 흉내 낸다. */
var __B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function btoa(bin) {
  var out = '', i;
  for (i = 0; i < bin.length; i += 3) {
    var has2 = i + 1 < bin.length, has3 = i + 2 < bin.length;
    var n = (bin.charCodeAt(i) << 16) | ((has2 ? bin.charCodeAt(i + 1) : 0) << 8) | (has3 ? bin.charCodeAt(i + 2) : 0);
    out += __B64[(n >> 18) & 63] + __B64[(n >> 12) & 63] + (has2 ? __B64[(n >> 6) & 63] : '=') + (has3 ? __B64[n & 63] : '=');
  }
  return out;
}
function atob(b64) {
  var s = String(b64).replace(/[^A-Za-z0-9+/=]/g, ''), out = '', i;
  for (i = 0; i < s.length; i += 4) {
    var a = __B64.indexOf(s[i]), b = __B64.indexOf(s[i + 1]);
    var c = s[i + 2] === '=' ? 0 : __B64.indexOf(s[i + 2]);
    var d = s[i + 3] === '=' ? 0 : __B64.indexOf(s[i + 3]);
    var n = (a << 18) | (b << 12) | (c << 6) | d;
    out += String.fromCharCode((n >> 16) & 255);
    if (s[i + 2] !== '=' && i + 2 < s.length) out += String.fromCharCode((n >> 8) & 255);
    if (s[i + 3] !== '=' && i + 3 < s.length) out += String.fromCharCode(n & 255);
  }
  return out;
}
"""

app_src = (ROOT / "app.js").read_text(encoding="utf-8")
admin_src = (ROOT / "admin.js").read_text(encoding="utf-8")
css = (ROOT / "style.css").read_text(encoding="utf-8")
html = (ROOT / "index.html").read_text(encoding="utf-8")
config = json.loads((ROOT / "site-config.json").read_text(encoding="utf-8"))


# ── 1. 문법 ───────────────────────────────────────────────────────
def syntax_ok(src):
    ctx = quickjs.Context()
    try:
        ctx.eval("var __s = " + json.dumps(src) + "; new Function(__s); true;")
        return True, ""
    except Exception as e:  # noqa: BLE001
        return False, str(e).splitlines()[-1] if str(e) else "syntax error"


for label, src in (("app.js", app_src), ("admin.js", admin_src)):
    ok, err = syntax_ok(src)
    check(f"문법: {label}", ok, err)


# ── 2. 앱 실행 (app.js) ───────────────────────────────────────────
def boot(src):
    ctx = quickjs.Context()
    ctx.eval(PRELUDE)
    ctx.eval(src)
    return ctx


try:
    app = boot(app_src)
    boot_error = ""
except Exception as e:  # noqa: BLE001
    app = None
    boot_error = str(e).splitlines()[-1] if str(e) else "load error"

check("app.js 로드", app is not None, boot_error)


def js(expr):
    return app.eval(expr)


if app is not None:
    # 사진 한 장만 있는 줄 → figure
    fig = js("renderMarkdown('![사진 설명](./assets/uploads/2026-11/a.webp)')")
    check("사진 figure 렌더", '<figure class="post-figure">' in fig, fig[:160])
    check("figure 사진 클래스", 'class="post-img"' in fig, fig[:160])
    check("figure 지연 로딩", 'loading="lazy"' in fig, fig[:160])
    check("figure 버튼 역할", 'role="button"' in fig, fig[:160])
    check("기본 설명은 캡션 아님", "<figcaption>" not in fig, fig[:200])
    check("figure 이미지 경로", 'src="./assets/uploads/2026-11/a.webp"' in fig, fig[:200])

    cap = js("renderMarkdown('![한강 노을](./x.jpg)')")
    check("설명 있으면 캡션", "<figcaption>한강 노을</figcaption>" in cap, cap[:200])

    for ph in ("image", "사진", "이미지", "photo"):
        out = js("renderMarkdown('![%s](./x.jpg)')" % ph)
        check(f"자리표시 설명 무시: {ph}", "<figcaption>" not in out, out[:160])

    inline = js("renderMarkdown('앞 문장 ![사진](./x.jpg) 뒤 문장')")
    check("인라인 사진은 문단 안", "<figure" not in inline and '<img class="post-img"' in inline, inline[:200])

    multi = js("renderMarkdown('![첫 사진](./a.jpg)\\n\\n![둘째 사진](./b.jpg)')")
    check("사진 두 장 모두 figure", multi.count('<figure class="post-figure">') == 2, multi[:200])

    noalt = js("renderMarkdown('![](./a.jpg)')")
    check("빈 설명도 figure", '<figure class="post-figure">' in noalt and "figcaption" not in noalt, noalt[:160])

    xss = js("renderMarkdown('![<b>제목</b>](./a.jpg)')")
    check("설명 HTML 이스케이프", "&lt;b&gt;" in xss and "<b>" not in xss, xss[:200])

    check(
        "placeholder 판정",
        js("isPlaceholderAlt('사진 설명') === true && isPlaceholderAlt('  IMAGE ') === true && isPlaceholderAlt('노을') === false"),
    )
    check("라이트박스 함수", js("typeof openLightbox === 'function' && typeof closeLightbox === 'function'"))
    check("사진 재시도 훅", js("typeof wirePhotoRetry === 'function'"))

    # 해시 라우팅
    js("location.hash = '#/post/hello'")
    check("라우팅 #/post", js("JSON.stringify(parseRoute())") == json.dumps({"name": "post", "slug": "hello"}, separators=(",", ":")), js("JSON.stringify(parseRoute())"))
    js("location.hash = '#!/post/hello'")
    check("라우팅 #!/post (Disqus 알림)", js("parseRoute().slug") == "hello", js("JSON.stringify(parseRoute())"))
    js("location.hash = '#!post/hello'")
    check("라우팅 #!post", js("parseRoute().slug") == "hello", js("JSON.stringify(parseRoute())"))
    js("location.hash = '#!/post/%ED%95%9C%EA%B8%80'")
    check("라우팅 인코딩된 슬러그", js("parseRoute().slug") == "한글", js("parseRoute().slug"))
    js("location.hash = ''; location.search = '?post=hello&utm_source=disqus'")
    js("routeFromQuery()")
    check("?post= 쿼리 전환", js("location.hash") == "#/post/hello", js("location.hash"))
    js("location.hash = '#/archive'; location.search = '?post=hello'")
    js("routeFromQuery()")
    check("다른 화면에서는 쿼리 무시", js("location.hash") == "#/archive", js("location.hash"))

    # Disqus 설정
    check("Disqus 주소", js("postShareUrl('test')") == "https://jeonsul.github.io/#!/post/test", js("postShareUrl('test')"))
    js("location.hash = '#/post/test'")
    js("siteConfig = { disqusShortname: 'jeonsul' }")
    check("Disqus shortname 검증", js("disqusShortname()") == "jeonsul", js("disqusShortname()"))
    js("siteConfig = { disqusShortname: 'Bad Name!' }")
    check("잘못된 shortname 무시", js("disqusShortname()") == "", js("disqusShortname()"))
    js("siteConfig = {}")
    check("설정 없으면 쉼", js("disqusShortname()") == "", js("disqusShortname()"))
    js("siteConfig = null")
    check("설정 로드 전 안전", js("disqusShortname()") == "", js("disqusShortname()"))
    js("siteConfig = { disqusShortname: 'jeonsul' }")
    js(
        "var __cfg = disqusConfig({ slug: 'hello', title: '블로그를 시작합니다' });"
        "var __scope = {}; __cfg.call(__scope); __CFG = __scope.page;"
    )
    check("Disqus page.identifier", js("__CFG.identifier") == "hello", js("String(__CFG.identifier)"))
    check("Disqus page.url 해시뱅", js("__CFG.url") == "https://jeonsul.github.io/#!/post/hello", js("String(__CFG.url)"))
    check("Disqus page.title", js("__CFG.title") == "블로그를 시작합니다", js("String(__CFG.title)"))
    # shortname이 비면 댓글 영역을 만들지 않는다 (document.querySelector('.post')가 null이므로 이 전에 반환)
    js("siteConfig = {}")
    check("설정 전 mountComments 무해", js("(function(){ try { mountComments({ slug: 'a', title: 'b' }); return true; } catch (e) { return false; } })()"))

# ── 3. 관리자 (admin.js) ─────────────────────────────────────────
admin = boot(admin_src)
check("admin.js 로드", admin is not None)


def ajs(expr):
    return admin.eval(expr)


check("관리자 테스트 훅", ajs("typeof window.BlogAdmin._test.uploadPhoto === 'function'"))
check("사진 긴 변 상한 1600", ajs("window.BlogAdmin._test.PHOTO.EDGE") == 1600, ajs("String(window.BlogAdmin._test.PHOTO.EDGE)"))
check("사진 상한 8MB", ajs("window.BlogAdmin._test.PHOTO.MAX_BYTES") == 8 * 1024 * 1024)
check("업로드 폴더", ajs("window.BlogAdmin._test.PHOTO.ROOT") == "assets/uploads")
check("이름 정리(영문)", ajs("window.BlogAdmin._test.safeFileName('IMG_0042 (1).HEIC')") == "img-0042-1", ajs("window.BlogAdmin._test.safeFileName('IMG_0042 (1).HEIC')"))
check("이름 정리(한글)", ajs("window.BlogAdmin._test.safeFileName('내 사진.jpg')") == "photo", ajs("window.BlogAdmin._test.safeFileName('내 사진.jpg')"))
check("월 폴더", ajs("window.BlogAdmin._test.uploadDirStamp(new Date(2026, 10, 17))") == "2026-11", ajs("window.BlogAdmin._test.uploadDirStamp(new Date(2026, 10, 17))"))
fname = ajs("window.BlogAdmin._test.uploadFileName('한강 sunset.JPG', 'webp')")
check(
    "업로드 파일 이름 형식",
    bool(re.fullmatch(r"\d{13}-[a-z0-9]{4}-sunset\.webp", fname)),
    fname,
)
check(
    "사진 마크다운",
    ajs("window.BlogAdmin._test.photoMarkdown('assets/uploads/2026-11/x.webp')")
    == "![사진 설명](./assets/uploads/2026-11/x.webp)",
    ajs("window.BlogAdmin._test.photoMarkdown('a.webp')"),
)
check("바이너리 base64", ajs("window.BlogAdmin._test.base64FromBytes(new Uint8Array([1,2,3,255]))") == "AQID/w==", ajs("window.BlogAdmin._test.base64FromBytes(new Uint8Array([1,2,3,255]))"))
check("긴 바이너리 base64 왕복", ajs("""
(function () {
  var bytes = new Uint8Array(70000);
  for (var i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  var b64 = window.BlogAdmin._test.base64FromBytes(bytes);
  var bin = atob(b64);
  if (bin.length !== bytes.length) return false;
  for (var j = 0; j < bytes.length; j++) if (bin.charCodeAt(j) !== bytes[j]) return false;
  return true;
})()
""") is True)
check(
    "업로드 경로 형식",
    bool(re.fullmatch(r"assets/uploads/\d{4}-\d{2}/\d{13}-[a-z0-9]{4}-[a-z0-9-]+\.(webp|jpg|gif|png|heic|avif|bmp|tiff?)",
                      "assets/uploads/" + ajs("window.BlogAdmin._test.uploadDirStamp(new Date())") + "/" + ajs("window.BlogAdmin._test.uploadFileName('photo.jpg', 'webp')"))),
)
check("사진 아닌 파일 거부", ajs("""
(function () {
  var err = null;
  var p = window.BlogAdmin._test.optimizePhoto({ name: 'a.txt', type: 'text/plain', size: 10 });
  return typeof p.then === 'function';
})()
"""))

# 커서 삽입: 문단 중간에 넣어도 사진이 독립된 줄에 놓이는지 (줄바꿈은 chr(10)으로 만든다)
NL2 = '+ String.fromCharCode(10,10)'
IMGM = "'![a](./a.jpg)'"

blocked = json.loads(ajs("JSON.stringify(window.BlogAdmin._test.insertPhotoBlock('앞 문장', 4, 4, " + IMGM + "))"))
check("커서 삽입 — 빈 줄 확보", blocked["value"] == "앞 문장\n\n![a](./a.jpg)\n", repr(blocked["value"]))
check("커서 삽입 — 커서 위치", blocked["caret"] == len(blocked["value"]), str(blocked["caret"]))

blank = json.loads(ajs("JSON.stringify(window.BlogAdmin._test.insertPhotoBlock('앞 문장' " + NL2 + ", 8, 8, " + IMGM + "))"))
check("커서 삽입 — 빈 줄 중복 없음", blank["value"] == "앞 문장\n\n![a](./a.jpg)\n", repr(blank["value"]))

empty = json.loads(ajs("JSON.stringify(window.BlogAdmin._test.insertPhotoBlock('', 0, 0, " + IMGM + "))"))
check("커서 삽입 — 빈 본문", empty["value"] == "![a](./a.jpg)\n", repr(empty["value"]))

mid = json.loads(ajs("JSON.stringify(window.BlogAdmin._test.insertPhotoBlock('가나다라', 2, 2, " + IMGM + "))"))
check("커서 삽입 — 글자 사이", mid["value"] == "가나\n\n![a](./a.jpg)\n\n다라", repr(mid["value"]))

# ── 4. CSS / 설정 / 캐시 버전 ────────────────────────────────────
check("사진 figure 스타일", ".prose .post-figure" in css and "border-radius: 16px" in css)
check("사진 반응형", re.search(r"\.prose \.post-figure img\s*\{[^}]*max-width:\s*100%", css) is not None)
check("라이트박스 스타일", ".lightbox {" in css and ".lightbox-img" in css and ".lightbox-close" in css)
check("라이트박스 배경", re.search(r"\.lightbox\s*\{[^}]*position:\s*fixed", css) is not None)
check("업로드 버튼 스타일", ".upload-bar" in css and ".upload-thumb" in css and ".editor-panes.is-dragover" in css)
check("댓글 카드 스타일", ".post-comments" in css and "#disqus_thread" in css and ".comments-fallback" in css)
check("설정 폼 제목 스타일", ".admin-form-title" in css)

check("site-config goatcounter 보존", config.get("goatcounterCode") == "gug761101", str(config.get("goatcounterCode")))
check("site-config disqus 키", "disqusShortname" in config, str(list(config)))
check("site-config disqus shortname", bool(re.fullmatch(r"[a-z0-9][a-z0-9-]{1,49}", str(config.get("disqusShortname") or ""))), str(config.get("disqusShortname")))

check("admin 설정에 Disqus 입력", "adminDisqus" in admin_src and "disqusShortname" in admin_src)
check("설정 저장 시 두 키 함께", "Object.assign({}, state.config" in admin_src)

versions = set(re.findall(r"\?v=([a-z0-9]+)", html))
check("캐시 버전 하나로 통일", len(versions) == 1, ",".join(versions))
check("캐시 버전 갱신", "20261117f" in versions, ",".join(versions))

print()
if failures:
    print(f"{len(failures)}개 실패: {failures}")
    sys.exit(1)
print("모든 사진·댓글 테스트 통과 ✓")
