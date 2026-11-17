/* 관리자 모드 (#/admin)
   GitHub Contents API로 글을 쓰고, 고치고, 지웁니다.
   외부 서버도 빌드도 없이 정적 사이트 안에서만 동작합니다.

   토큰은 이 브라우저의 저장소(localStorage 또는 sessionStorage)에만 들어가고
   저장소 파일에는 절대 기록하지 않습니다. */

(function () {
  'use strict';

  const OWNER = 'Jeonsul';
  const REPO = 'Jeonsul.github.io';
  const BRANCH = 'main';
  const API = 'https://api.github.com';
  const TOKEN_KEY = 'jeonsul.blog.token';
  const DRAFT_KEY = 'jeonsul.blog.draft.v1';
  const CODE_RE = /^[a-z0-9][a-z0-9-]{1,49}$/;
  const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  const state = {
    token: null,
    session: null,
    persist: true,
    draft: null,
    index: [],
    config: { goatcounterCode: '', disqusShortname: '' },
    configSha: null,
    flash: null,
    seq: 0,
    flush: null,
  };

  // 닫히기 직전에 임시저장을 한 번 더 밀어 넣는다 (입력 후 0.45초가 지나기 전에 닫혀도 잃지 않게)
  const flushDraft = () => {
    if (state.flush) state.flush();
  };
  window.addEventListener('beforeunload', flushDraft);
  window.addEventListener('pagehide', flushDraft);

  /* ── 작은 도우미 ──────────────────────────────────────── */

  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  function todayISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function formatStamp(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function b64encode(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function b64decode(b64) {
    const clean = String(b64 || '').replace(/\s+/g, '');
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  /* ── 사진 준비 · 업로드 ─────────────────────────────────
     에디터에서 고른 사진을 브라우저 안에서 줄인 뒤
     GitHub Contents API(assets/uploads/...)로 올린다. */

  const UPLOAD_ROOT = 'assets/uploads';
  const PHOTO_EDGE = 1600; // 긴 변 최대 길이(px)
  const PHOTO_QUALITY = 0.85;
  const PHOTO_MAX_BYTES = 8 * 1024 * 1024; // 변환도 안 되는 파일의 상한
  const GIF_KEEP_BYTES = 8 * 1024 * 1024; // 움직이는 GIF는 원본 그대로(애니메이션 보존)
  const PHOTO_EXT_RE = /\.(jpe?g|png|webp|gif|heic|heif|bmp|avif|tiff?)$/i;
  const DEFAULT_ALT = '사진 설명';

  function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'MB';
    return Math.max(1, Math.round(n / 1024)) + 'KB';
  }

  function fileExt(name) {
    const m = String(name || '').match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  }

  /* 파일 이름에서 주소에 쓸 수 있는 부분만 남긴다 (한글 이름은 photo로) */
  function safeFileName(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '');
    const ascii = base
      .replace(/[^\x20-\x7e]/g, '-')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return ascii || 'photo';
  }

  function uploadDirStamp(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function uploadFileName(name, ext) {
    const rand = Math.random().toString(36).slice(2, 6);
    return Date.now() + '-' + rand + '-' + safeFileName(name) + '.' + (ext || 'jpg');
  }

  function base64FromBytes(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function readBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('READ_FAILED'));
      reader.readAsArrayBuffer(blob);
    });
  }

  function tooBigError(file) {
    const err = new Error(
      (file && file.name ? "'" + file.name + "' " : '고른 사진 ') +
        humanSize(file && file.size) +
        ' · 사진이 너무 큽니다. 8MB 이하 사진을 골라 주세요.'
    );
    err.tooBig = true;
    return err;
  }

  /* 사진을 그릴 수 있는 소스(bitmap 또는 img)로 푼다. 실패하면 예외. */
  async function decodePhoto(file) {
    if (window.createImageBitmap) {
      try {
        const bitmap = await window.createImageBitmap(file);
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: () => {
            if (bitmap.close) bitmap.close();
          },
        };
      } catch (e) {
        /* 사파리에서 HEIC 등은 이 길로 못 갈 수 있다 — 아래 img 경로로 */
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      if (img.decode) await img.decode();
      else
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('NO_SIZE');
      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: () => URL.revokeObjectURL(url),
      };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }

  function canvasWebpSupported() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      return canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) {
      return false;
    }
  }

  function toBlobAsync(canvas, type, quality) {
    return new Promise((resolve) => {
      if (!canvas.toBlob) return resolve(null);
      canvas.toBlob((blob) => resolve(blob || null), type, quality);
    });
  }

  /* 긴 변을 PHOTO_EDGE로 줄여 WebP(실패하면 JPEG)로 다시 담는다. */
  async function shrinkPhoto(source, width, height) {
    if (!width || !height) return null;
    const scale = Math.min(1, PHOTO_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);

    const webp = canvasWebpSupported();
    let blob = await toBlobAsync(canvas, webp ? 'image/webp' : 'image/jpeg', PHOTO_QUALITY);
    let ext = webp ? 'webp' : 'jpg';
    let mime = webp ? 'image/webp' : 'image/jpeg';
    if (!blob) {
      blob = await toBlobAsync(canvas, 'image/jpeg', PHOTO_QUALITY);
      ext = 'jpg';
      mime = 'image/jpeg';
    }
    if (!blob) return null;
    return { blob: blob, ext: ext, mime: mime, width: w, height: h, resized: scale < 1 };
  }

  async function optimizePhoto(file) {
    const ext = fileExt(file.name);
    const type = String(file.type || '').toLowerCase();
    const looksImage = type.indexOf('image/') === 0 || PHOTO_EXT_RE.test('.' + ext);
    if (!looksImage) {
      const err = new Error(
        (file.name ? "'" + file.name + "'는" : '고른 파일은') +
          ' 사진이 아닙니다. JPEG·PNG·WEBP·GIF·HEIC 사진을 골라 주세요.'
      );
      err.notImage = true;
      throw err;
    }

    // 움직이는 GIF: 캔버스를 거치면 첫 장면만 남으므로 원본을 그대로 올린다.
    if (type === 'image/gif' || ext === 'gif') {
      if (file.size > GIF_KEEP_BYTES) throw tooBigError(file);
      return { blob: file, ext: 'gif', mime: 'image/gif', original: true, width: 0, height: 0 };
    }
    // 벡터(SVG)는 다시 그리면 의미가 없다.
    if (type === 'image/svg+xml' || ext === 'svg') {
      if (file.size > PHOTO_MAX_BYTES) throw tooBigError(file);
      return { blob: file, ext: 'svg', mime: 'image/svg+xml', original: true };
    }

    let decoded = null;
    try {
      decoded = await decodePhoto(file);
      const out = await shrinkPhoto(decoded.source, decoded.width, decoded.height);
      if (out) {
        // 이미 작은 사진은 다시 담는 쪽이 더 무거울 수 있다 — 원본 유지
        if (!out.resized && out.blob.size >= file.size && file.size <= PHOTO_MAX_BYTES) {
          return {
            blob: file,
            ext: ext || out.ext,
            mime: type || out.mime,
            original: true,
            width: out.width,
            height: out.height,
          };
        }
        return out;
      }
    } catch (e) {
      /* 캔버스로 못 읽는 포맷은 원본 바이너리로 넘긴다 */
    } finally {
      if (decoded && decoded.release) decoded.release();
    }

    if (file.size > PHOTO_MAX_BYTES) throw tooBigError(file);
    return { blob: file, ext: ext || 'jpg', mime: type || 'application/octet-stream', original: true };
  }

  async function uploadPhoto(file) {
    const optimized = await optimizePhoto(file);
    const path = UPLOAD_ROOT + '/' + uploadDirStamp(new Date()) + '/' + uploadFileName(file.name, optimized.ext);
    const bytes = new Uint8Array(await readBytes(optimized.blob));
    const res = await gh(`/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: 'PUT',
      body: {
        message: '사진 추가: ' + path.split('/').pop(),
        content: base64FromBytes(bytes),
        branch: BRANCH,
      },
    });
    return {
      path: path,
      optimized: optimized,
      sha: res && res.content ? res.content.sha : null,
    };
  }

  function photoMarkdown(path) {
    return '![' + DEFAULT_ALT + '](./' + path + ')';
  }

  /* 사진은 독립된 줄에 놓여야 figure로 그려진다 → 앞뒤에 빈 줄을 만든다. */
  function insertPhotoBlock(value, start, end, md) {
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = !before ? '' : /\n\s*\n$/.test(before) ? '' : /\n$/.test(before) ? '\n' : '\n\n';
    const tail = !after ? '\n' : /^\n/.test(after) ? '\n' : '\n\n';
    const block = lead + md + tail;
    return { value: before + block + after, caret: (before + block).length };
  }

  function tagLabel(t) {
    const map = (typeof TAGS !== 'undefined' && TAGS) || {};
    return map[t] || t;
  }

  function invalidateSite() {
    if (window.blogData && typeof window.blogData.invalidate === 'function') window.blogData.invalidate();
  }

  /* ── 토큰 보관 ────────────────────────────────────────── */

  function readToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  function storeToken(token, persist) {
    try {
      if (persist) {
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.removeItem(TOKEN_KEY);
      } else {
        sessionStorage.setItem(TOKEN_KEY, token);
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch (e) {
      /* 저장이 막힌 브라우저(사생활 보호 모드)에서도 이번 세션은 계속 쓸 수 있게 둔다 */
    }
  }

  function clearToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* 무시 */
    }
    state.token = null;
    state.session = null;
  }

  /* ── 임시저장 ─────────────────────────────────────────── */

  function readDraftStore() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function writeDraftStore(draft) {
    if (!draft) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(Object.assign({}, draft, { savedAt: Date.now() })));
    } catch (e) {
      /* 무시 */
    }
  }

  function clearDraftStore() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch (e) {
      /* 무시 */
    }
  }

  /* ── GitHub API ───────────────────────────────────────── */

  async function gh(path, options) {
    const opts = options || {};
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = opts.token || state.token;
    if (token) headers.Authorization = 'Bearer ' + token;
    if (opts.body) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(API + path, {
        method: opts.method || 'GET',
        headers: headers,
        cache: 'no-store',
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      const err = new Error('NETWORK');
      err.network = true;
      throw err;
    }

    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.json();
        if (data && data.message) detail = data.message;
      } catch (e) {
        /* 본문이 JSON이 아닐 수 있다 */
      }
      const err = new Error(detail || String(res.status));
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function verifyToken(token) {
    const user = await gh('/user', { token: token });
    let repo = null;
    try {
      repo = await gh(`/repos/${OWNER}/${REPO}`, { token: token });
    } catch (e) {
      if (e.status === 404) {
        const err = new Error('REPO_NOT_FOUND');
        err.repoMissing = true;
        throw err;
      }
      throw e;
    }
    const canWrite = Boolean(repo && repo.permissions && (repo.permissions.push || repo.permissions.admin));
    return { user: user, repo: repo, canWrite: canWrite };
  }

  async function getFile(path) {
    try {
      const data = await gh(`/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`);
      if (Array.isArray(data) || !data || !data.sha) return null;
      return {
        sha: data.sha,
        text: data.encoding === 'base64' ? b64decode(data.content) : '',
      };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async function putFile(path, text, sha, message) {
    const body = {
      message: message,
      content: b64encode(text),
      branch: BRANCH,
    };
    if (sha) body.sha = sha;
    return gh(`/repos/${OWNER}/${REPO}/contents/${path}`, { method: 'PUT', body: body });
  }

  async function deleteFile(path, sha, message) {
    return gh(`/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: 'DELETE',
      body: { message: message, sha: sha, branch: BRANCH },
    });
  }

  function apiErrorText(err) {
    if (!err) return '알 수 없는 오류가 났습니다.';
    if (err.network) return 'GitHub에 연결하지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.';
    if (err.repoMissing) return '저장소를 찾지 못했습니다. 토큰의 Repository access에 Jeonsul.github.io가 들어 있는지 확인해 주세요.';
    if (err.status === 401) return '토큰이 올바르지 않거나 만료됐습니다. 새 토큰을 만들어 다시 로그인해 주세요.';
    if (err.status === 403) return "쓰기 권한이 없습니다. GitHub 토큰 설정에서 Repository access를 'Only select repositories → Jeonsul.github.io'로 고르고(Public repositories는 읽기 전용), Permissions의 Contents를 'Read and write'로 바꿨는지 확인해 주세요.";
    if (err.slugTaken) return err.message;
    if (err.status === 404) return '저장소에서 파일을 찾지 못했습니다.';
    if (err.status === 409 || err.status === 422) return '저장이 겹쳤습니다. 잠시 뒤 다시 시도해 주세요. (' + (err.message || err.status) + ')';
    return 'GitHub 요청이 실패했습니다. (' + (err.message || err.status || 'error') + ')';
  }

  /* 오류 본문은 그대로 두고, GitHub이 보낸 원문 메시지는 작게 덧붙입니다. */
  function setApiError(el, err) {
    if (!el) return;
    el.textContent = apiErrorText(err);
    const detail = err && err.message ? String(err.message) : '';
    if (!detail || detail === el.textContent) return;
    const small = document.createElement('span');
    small.className = 'msg-detail';
    small.textContent = detail;
    el.appendChild(small);
  }

  /* ── 글 데이터 ────────────────────────────────────────── */

  async function loadIndex() {
    const file = await getFile('posts.json');
    if (!file) throw new Error('posts.json을 찾지 못했습니다.');
    let list = [];
    try {
      list = JSON.parse(file.text);
    } catch (e) {
      throw new Error('posts.json 형식이 올바르지 않습니다.');
    }
    if (!Array.isArray(list)) throw new Error('posts.json 형식이 올바르지 않습니다.');
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return list;
  }

  async function loadConfig() {
    const file = await getFile('site-config.json');
    const cfg = { goatcounterCode: '', disqusShortname: '' };
    if (file) {
      try {
        const parsed = JSON.parse(file.text);
        if (parsed && typeof parsed === 'object') {
          // 모르는 키는 그대로 보존한다.
          Object.keys(parsed).forEach((key) => {
            cfg[key] = parsed[key];
          });
          cfg.goatcounterCode = typeof parsed.goatcounterCode === 'string' ? parsed.goatcounterCode : '';
          cfg.disqusShortname = typeof parsed.disqusShortname === 'string' ? parsed.disqusShortname : '';
        }
      } catch (e) {
        /* 깨진 설정은 빈 값으로 본다 */
      }
    }
    return { config: cfg, sha: file ? file.sha : null };
  }

  async function loadPostForEdit(slug) {
    const file = await getFile(`posts/${slug}.md`);
    if (!file) return null;
    const list = await loadIndex();
    const entry = list.find((p) => p.slug === slug) || { slug: slug, title: slug, date: todayISO(), tags: [], summary: '' };
    return {
      slug: entry.slug,
      title: entry.title || '',
      date: entry.date || todayISO(),
      tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
      summary: entry.summary || '',
      body: file.text.replace(/\r\n/g, '\n').replace(/\s+$/, ''),
    };
  }

  async function loadPostBody(slug) {
    const file = await getFile(`posts/${slug}.md`);
    return file ? file.text.replace(/\r\n/g, '\n').replace(/\s+$/, '') : null;
  }

  /* ── 조각 HTML ────────────────────────────────────────── */

  function loadingView(text) {
    return `<div class="admin-loading" role="status"><span class="admin-spinner" aria-hidden="true"></span>${esc(text)}</div>`;
  }

  function errorView(text) {
    return `<div class="admin-flash is-error" role="alert">${esc(text)}</div>
      <p class="admin-back"><a href="#/admin">← 글 목록으로</a></p>`;
  }

  function flashView() {
    const f = state.flash;
    if (!f) return '';
    state.flash = null;
    return `<div class="admin-flash ${f.type === 'error' ? 'is-error' : 'is-ok'}" role="status">${esc(f.text)}</div>`;
  }

  function headHtml(title, note) {
    return `<header class="page-head admin-head fade-in">
      <p class="eyebrow"><span class="dot"></span>관리자</p>
      <h1>${esc(title)}</h1>
      ${note ? `<p>${note}</p>` : ''}
    </header>`;
  }

  /* ── 로그인 화면 ──────────────────────────────────────── */

  function renderLogin(root, message) {
    state.session = null;
    root.innerHTML = `
      ${headHtml('관리', '이 브라우저에서만 쓰는 열쇠로 로그인합니다. 토큰은 블로그 파일에 기록되지 않습니다.')}
      <section class="admin-card fade-in">
        <form id="adminLogin" class="admin-form" novalidate>
          <label class="field">
            <span class="field-label">GitHub 토큰 (Fine-grained PAT)</span>
            <input id="adminToken" type="password" name="token" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_..." required>
          </label>
          <label class="check">
            <input type="checkbox" id="adminPersist" ${state.persist ? 'checked' : ''}>
            <span>이 기기에 로그인 유지</span>
          </label>
          <p class="field-hint">체크를 끄면 브라우저를 닫을 때 로그인이 풀립니다. 공용 기기에서는 끄세요.</p>
          <div class="admin-actions">
            <button class="btn btn-primary" type="submit">로그인</button>
          </div>
          <p class="admin-msg" id="adminLoginMsg" role="status" aria-live="polite">${esc(message || '')}</p>
        </form>

        <details class="admin-help">
          <summary>GitHub 토큰 발급 방법 (3단계)</summary>
          <ol>
            <li>GitHub에 로그인하고 <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">새 Fine-grained token 만들기</a>를 엽니다. (Settings → Developer settings → Personal access tokens → Fine-grained tokens)</li>
            <li><b>Repository access</b>에서 <b>Only select repositories</b>를 고르고 <b>Jeonsul.github.io</b>만 선택합니다. 아래 <b>Permissions → Repository permissions → Contents</b>를 <b>Read and write</b>로 바꿉니다. 만료일은 90일 정도면 충분합니다.</li>
            <li><b>Generate token</b>을 누르고, 한 번만 보이는 <code>github_pat_...</code> 값을 복사해 위 칸에 붙여 넣습니다.</li>
          </ol>
          <p>토큰은 이 브라우저에만 저장되고, 블로그 파일이나 GitHub 저장소에는 절대 기록되지 않습니다. 토큰을 잃어버리면 GitHub에서 지우고 새로 만들면 됩니다.</p>
        </details>
      </section>`;

    const form = document.getElementById('adminLogin');
    const input = document.getElementById('adminToken');
    const persist = document.getElementById('adminPersist');
    const msg = document.getElementById('adminLoginMsg');
    const button = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = input.value.trim();
      if (!token) {
        msg.textContent = '토큰을 입력해 주세요.';
        input.focus();
        return;
      }
      button.disabled = true;
      button.textContent = '확인 중…';
      msg.textContent = '';
      try {
        const result = await verifyToken(token);
        if (!result.canWrite) {
          msg.textContent = '이 토큰에는 저장소 쓰기 권한이 없습니다. Permissions의 Contents를 Read and write로 바꿔 주세요.';
          return;
        }
        state.token = token;
        state.session = result.user;
        state.persist = persist.checked;
        storeToken(token, persist.checked);
        render(root, { name: 'admin', sub: '', arg: '' });
      } catch (err) {
        setApiError(msg, err);
      } finally {
        button.disabled = false;
        button.textContent = '로그인';
      }
    });
  }

  /* ── 방문자 통계 ──────────────────────────────────────── */

  function counterUrl(code, path) {
    return `https://${code}.goatcounter.com/counter/${encodeURIComponent(path)}.json`;
  }

  async function requestCount(code, paths) {
    let lastStatus = 0;
    for (let i = 0; i < paths.length; i++) {
      let res;
      try {
        res = await fetch(counterUrl(code, paths[i]), { cache: 'no-store' });
      } catch (e) {
        throw e;
      }
      if (res.ok) {
        const data = await res.json();
        return { count: String(data && data.count != null ? data.count : '0'), path: paths[i] };
      }
      lastStatus = res.status;
      if (res.status !== 404) break;
    }
    if (lastStatus === 404) return { count: '0', path: paths[paths.length - 1], empty: true };
    const err = new Error('counter ' + lastStatus);
    err.status = lastStatus;
    throw err;
  }

  /* ── 대시보드 ─────────────────────────────────────────── */

  function dashboardHtml(index, config, done) {
    const code = config.goatcounterCode || '';
    const disqus = config.disqusShortname || '';
    const posts = index
      .map(
        (p) => `<li class="admin-post">
          <div class="admin-post-main">
            <a class="admin-post-title" href="#/post/${encodeURIComponent(p.slug)}">${esc(p.title)}</a>
            <p class="admin-post-meta"><time datetime="${esc(p.date)}">${esc(p.date)}</time> · ${(p.tags || []).map((t) => '#' + esc(tagLabel(t))).join(' ')}</p>
          </div>
          <div class="admin-post-actions">
            <a class="btn btn-sm" href="#/post/${encodeURIComponent(p.slug)}">보기</a>
            <a class="btn btn-sm" href="#/admin/edit/${encodeURIComponent(p.slug)}">수정</a>
            <button class="btn btn-sm btn-danger" type="button" data-delete="${esc(p.slug)}" data-title="${esc(p.title)}">삭제</button>
          </div>
        </li>`
      )
      .join('');

    const doneHtml = done
      ? `<div class="admin-card admin-done fade-in">
          <h2>저장했습니다</h2>
          <p>GitHub에 커밋했고, 사이트 반영까지 30초에서 1분 정도 걸립니다.</p>
          <p class="admin-actions">
            <a class="btn btn-primary" href="#/post/${encodeURIComponent(done)}">글 보기</a>
            <a class="btn" href="#/admin">글 목록</a>
          </p>
        </div>`
      : '';

    return `
      ${headHtml('관리', '@' + esc(state.session ? state.session.login : '') + '로 로그인했습니다. 글을 쓰면 바로 이 저장소에 커밋됩니다.')}
      ${flashView()}
      ${doneHtml}
      <section class="admin-card fade-in">
        <div class="admin-card-head">
          <h2>방문자 통계</h2>
          <span class="admin-card-tag">GoatCounter · Disqus</span>
        </div>
        <div id="adminStats" class="admin-stats">
          ${
            code
              ? `<div class="stat-grid">
                   <div class="stat"><span class="stat-value" id="statTotal">–</span><span class="stat-label">전체 방문</span></div>
                 </div>
                 <ul class="stat-list" id="statPosts"></ul>`
              : `<p class="admin-empty">아직 GoatCounter 코드가 없습니다. 아래에 코드를 넣고 저장하면 블로그가 방문자를 세기 시작합니다.</p>`
          }
        </div>
        <p class="admin-note" id="statNote" aria-live="polite"></p>
        <div class="admin-links">
          ${
            code
              ? `<a href="https://${esc(code)}.goatcounter.com" target="_blank" rel="noopener">GoatCounter 대시보드 열기 ↗</a>
                 <span>·</span>
                 <span>번호는 최대 4시간 늦게 반영됩니다.</span>`
              : `<a href="https://www.goatcounter.com/" target="_blank" rel="noopener">GoatCounter 가입 ↗</a>`
          }
        </div>
        <p class="admin-hint">숫자가 ‘–’로 보이면 GoatCounter <b>Settings</b>에서 <b>Allow adding visitor counts on your website</b>를 켜고, <b>Site’s Domain</b>에 <code>jeonsul.github.io</code>를 넣어 주세요. 설정을 바꾼 뒤 몇 분 걸릴 수 있습니다.</p>

        <form id="adminConfig" class="admin-form admin-config" novalidate>
          <p class="admin-form-title">사이트 설정</p>
          <label class="field">
            <span class="field-label">GoatCounter 코드</span>
            <input id="adminCode" type="text" value="${esc(code)}" placeholder="jeonsul" autocomplete="off" autocapitalize="off" spellcheck="false">
            <span class="field-hint">가입할 때 정한 코드입니다. 비우고 저장하면 추적을 끕니다. 예: <code>jeonsul</code> → https://jeonsul.goatcounter.com</span>
          </label>
          <label class="field">
            <span class="field-label">Disqus Shortname</span>
            <input id="adminDisqus" type="text" value="${esc(disqus)}" placeholder="jeonsul" autocomplete="off" autocapitalize="off" spellcheck="false">
            <span class="field-hint">Disqus에 사이트를 만들고 정한 shortname입니다. 넣으면 글 아래에 댓글이 붙고, 비우면 댓글 영역이 아예 나타나지 않습니다. 예: <code>jeonsul</code> → https://jeonsul.disqus.com</span>
          </label>
          <div class="admin-actions">
            <button class="btn btn-primary" type="submit">설정 저장</button>
            <span class="admin-msg" id="adminConfigMsg" role="status" aria-live="polite"></span>
          </div>
        </form>
      </section>

      <section class="admin-card fade-in">
        <div class="admin-card-head">
          <h2>글 <span class="count">${index.length}</span></h2>
          <div class="admin-actions">
            <a class="btn btn-primary" href="#/admin/new">+ 새 글 쓰기</a>
            <button class="btn" type="button" id="adminLogout">로그아웃</button>
          </div>
        </div>
        ${index.length ? `<ul class="admin-list">${posts}</ul>` : '<p class="admin-empty">아직 올린 글이 없습니다. 첫 글을 써 보세요.</p>'}
      </section>`;
  }

  async function loadStats(code, index) {
    const totalEl = document.getElementById('statTotal');
    const listEl = document.getElementById('statPosts');
    const noteEl = document.getElementById('statNote');
    if (!totalEl || !listEl) return;

    if (listEl) {
      listEl.innerHTML = index
        .map(
          (p) => `<li><a href="#/post/${encodeURIComponent(p.slug)}">${esc(p.title)}</a><span class="stat-count" data-count="${esc(p.slug)}">–</span></li>`
        )
        .join('');
    }

    try {
      const total = await requestCount(code, ['TOTAL']);
      totalEl.textContent = total.count;
    } catch (err) {
      totalEl.textContent = '–';
      if (noteEl) {
        noteEl.textContent =
          '통계를 불러오지 못했습니다. GoatCounter Settings의 ‘Allow adding visitor counts on your website’와 ‘Site’s Domain’(jeonsul.github.io) 설정을 확인해 주세요.';
        noteEl.classList.add('is-error');
      }
      return;
    }

    const results = await Promise.all(
      index.map(async (p) => {
        const path = '#/post/' + p.slug;
        try {
          const r = await requestCount(code, [path, '/' + path]);
          return { slug: p.slug, count: r.count };
        } catch (e) {
          return { slug: p.slug, count: '–' };
        }
      })
    );
    results.forEach((r) => {
      const el = listEl.querySelector(`[data-count="${r.slug}"]`);
      if (el) el.textContent = r.count;
    });
    if (noteEl && !noteEl.textContent) noteEl.textContent = '아직 집계되지 않은 글은 0으로 보입니다.';
  }

  /* ── 에디터 ───────────────────────────────────────────── */

  function blankDraft() {
    return { isNew: true, originalSlug: null, slug: '', title: '', date: todayISO(), tags: [], excerpt: '', body: '' };
  }

  function draftFromPost(post) {
    return {
      isNew: false,
      originalSlug: post.slug,
      slug: post.slug,
      title: post.title,
      date: post.date,
      tags: post.tags.slice(),
      excerpt: post.summary,
      body: post.body,
    };
  }

  function sameContent(a, b) {
    return (
      a.title === b.title &&
      a.slug === b.slug &&
      a.date === b.date &&
      a.excerpt === b.excerpt &&
      a.body === b.body &&
      a.tags.join(',') === b.tags.join(',')
    );
  }

  function pickDraft(base, isNew, slug) {
    const fresh = isNew ? blankDraft() : draftFromPost(base);
    const stored = readDraftStore();
    if (!stored || !stored.savedAt) return { draft: fresh, restored: 0 };
    const sameTarget = Boolean(stored.isNew) === Boolean(isNew) && (stored.isNew ? !stored.originalSlug : stored.originalSlug === slug);
    if (!sameTarget) return { draft: fresh, restored: 0 };
    const candidate = {
      isNew: Boolean(isNew),
      originalSlug: isNew ? null : slug,
      slug: typeof stored.slug === 'string' ? stored.slug : fresh.slug,
      title: typeof stored.title === 'string' ? stored.title : fresh.title,
      date: typeof stored.date === 'string' && stored.date ? stored.date : fresh.date,
      tags: Array.isArray(stored.tags) ? stored.tags.filter((t) => typeof t === 'string') : fresh.tags,
      excerpt: typeof stored.excerpt === 'string' ? stored.excerpt : fresh.excerpt,
      body: typeof stored.body === 'string' ? stored.body : fresh.body,
    };
    if (!isNew && sameContent(candidate, fresh)) return { draft: fresh, restored: 0 };
    if (isNew && !candidate.title && !candidate.body && !candidate.slug) return { draft: fresh, restored: 0 };
    return { draft: candidate, restored: stored.savedAt };
  }

  function tagButtons(selected) {
    const map = (typeof TAGS !== 'undefined' && TAGS) || { ai: 'AI·개발', music: '음악', photo: '사진', life: '일상' };
    return Object.keys(map)
      .map(
        (id) =>
          `<button class="tag-toggle" type="button" data-tag="${esc(id)}" aria-pressed="${selected.indexOf(id) >= 0 ? 'true' : 'false'}">#${esc(map[id])}</button>`
      )
      .join('');
  }

  function editorHtml(draft, isNew, restoredAt) {
    const title = isNew ? '새 글' : '글 고치기';
    const crumb = isNew
      ? '<a href="#/admin">← 글 목록</a>'
      : `<a href="#/admin">← 글 목록</a> · <a href="#/post/${encodeURIComponent(draft.originalSlug || draft.slug)}">글 보기</a>`;
    const saveLabel = isNew ? '게시' : '수정 저장';

    return `
      ${headHtml(title, '')}
      <p class="admin-crumb fade-in">${crumb}</p>
      <form id="adminEditor" class="admin-form admin-editor fade-in" data-view="write" novalidate>
        ${
          restoredAt
            ? `<div class="draft-bar" id="draftBar">임시저장본을 불러왔습니다 <span class="draft-time">${esc(formatStamp(restoredAt))}</span>
                 <button type="button" class="btn btn-sm" data-draft="discard">임시저장 버리기</button></div>`
            : ''
        }
        <div class="editor-grid">
          <label class="field">
            <span class="field-label">제목</span>
            <input id="fTitle" type="text" value="${esc(draft.title)}" placeholder="글 제목" autocomplete="off">
          </label>
          <label class="field">
            <span class="field-label">주소(슬러그)</span>
            <input id="fSlug" type="text" value="${esc(draft.slug)}" placeholder="hello-world" autocomplete="off" autocapitalize="off" spellcheck="false">
            <span class="field-hint" id="slugHint">영문 소문자·숫자·하이픈만. 주소는 <code>#/post/${esc(draft.slug || 'hello-world')}</code>가 됩니다.</span>
          </label>
        </div>
        <div class="editor-grid">
          <label class="field field-date">
            <span class="field-label">날짜</span>
            <input id="fDate" type="date" value="${esc(draft.date)}">
          </label>
          <div class="field">
            <span class="field-label">태그</span>
            <div class="tag-toggles" id="fTags">${tagButtons(draft.tags)}</div>
          </div>
        </div>
        <label class="field">
          <span class="field-label">한 줄 요약</span>
          <input id="fExcerpt" type="text" value="${esc(draft.excerpt)}" placeholder="목록에 보일 한두 문장" autocomplete="off">
        </label>
        <div class="field">
          <div class="editor-toolbar">
            <span class="field-label">본문 (마크다운)</span>
            <div class="seg" role="tablist" aria-label="본문 보기 방식">
              <button type="button" role="tab" data-view="write" aria-selected="true">작성</button>
              <button type="button" role="tab" data-view="split" aria-selected="false" class="seg-wide">나란히</button>
              <button type="button" role="tab" data-view="preview" aria-selected="false">미리보기</button>
            </div>
          </div>
          <div class="upload-bar">
            <div class="upload-row">
              <button class="btn btn-sm upload-btn" type="button" id="photoPick">📷 사진 넣기</button>
              <input class="photo-input" id="photoInput" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true">
              <span class="upload-hint">끌어다 놓거나 붙여넣어도 됩니다</span>
            </div>
            <p class="upload-status" id="uploadStatus" role="status" aria-live="polite"></p>
            <ul class="upload-strip" id="uploadStrip" aria-label="올린 사진" hidden></ul>
          </div>
          <div class="editor-panes">
            <textarea id="fBody" spellcheck="false" placeholder="# 제목&#10;&#10;본문을 씁니다. **굵게**, *기울임*, &#96;코드&#96;, - 목록, &gt; 인용을 쓸 수 있습니다.">${esc(draft.body)}</textarea>
            <div class="editor-preview prose" id="fPreview" aria-live="polite"></div>
          </div>
        </div>
        <p class="admin-msg" id="editorMsg" role="status" aria-live="polite"></p>
        <div class="editor-actions">
          <button class="btn btn-primary" type="submit" id="editorSave">${saveLabel}</button>
          <a class="btn" href="#/admin">취소</a>
          <span class="draft-note" id="draftNote">작성 중인 내용은 이 기기에 자동으로 임시저장됩니다.</span>
        </div>
      </form>`;
  }

  function wireEditor(root, draft, isNew, base) {
    const form = document.getElementById('adminEditor');
    if (!form) return;
    const fTitle = document.getElementById('fTitle');
    const fSlug = document.getElementById('fSlug');
    const fDate = document.getElementById('fDate');
    const fExcerpt = document.getElementById('fExcerpt');
    const fBody = document.getElementById('fBody');
    const fPreview = document.getElementById('fPreview');
    const fTags = document.getElementById('fTags');
    const msg = document.getElementById('editorMsg');
    const saveBtn = document.getElementById('editorSave');
    const slugHint = document.getElementById('slugHint');
    const draftNote = document.getElementById('draftNote');

    state.draft = draft;

    const read = () => ({
      isNew: draft.isNew,
      originalSlug: draft.originalSlug,
      slug: fSlug.value.trim(),
      title: fTitle.value.trim(),
      date: fDate.value,
      tags: draft.tags.slice(),
      excerpt: fExcerpt.value.trim(),
      body: fBody.value,
    });

    let saveTimer = null;
    let slugTouched = Boolean(draft.slug);
    let disposed = false;

    state.flush = () => {
      if (disposed) return;
      const current = read();
      state.draft = current;
      writeDraftStore(current);
    };

    function scheduleSave() {
      if (disposed) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const current = read();
        state.draft = current;
        writeDraftStore(current);
        if (draftNote) draftNote.textContent = '임시저장됨 · ' + formatStamp(Date.now());
      }, 450);
    }

    function refreshPreview() {
      if (form.dataset.view === 'write') return;
      const md = fBody.value;
      fPreview.innerHTML = md.trim()
        ? renderMarkdown(md)
        : '<p class="admin-empty">본문을 쓰면 여기에 그대로 보입니다.</p>';
      paintLocalPhotos();
    }

    function syncSlugHint() {
      const slug = fSlug.value.trim();
      if (!slug) {
        slugHint.innerHTML = '영문 소문자·숫자·하이픈만. 예: <code>hello-world</code>';
      } else if (!SLUG_RE.test(slug)) {
        slugHint.innerHTML = '영문 소문자·숫자·하이픈만 쓸 수 있습니다. 예: <code>hello-world</code>';
        slugHint.classList.add('is-error');
      } else {
        slugHint.innerHTML = '주소는 <code>#/post/' + esc(slug) + '</code>가 됩니다.';
        slugHint.classList.remove('is-error');
      }
    }

    fTitle.addEventListener('input', () => {
      if (isNew && !slugTouched) {
        const candidate = fTitle.value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (candidate) {
          fSlug.value = candidate;
          syncSlugHint();
        }
      }
      scheduleSave();
    });

    fSlug.addEventListener('input', () => {
      slugTouched = true;
      syncSlugHint();
      scheduleSave();
    });

    fSlug.addEventListener('blur', () => {
      const clean = fSlug.value
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (clean !== fSlug.value) {
        fSlug.value = clean;
        syncSlugHint();
        scheduleSave();
      }
    });

    [fDate, fExcerpt].forEach((el) => {
      el.addEventListener('input', scheduleSave);
      el.addEventListener('change', scheduleSave);
    });

    fBody.addEventListener('input', () => {
      scheduleSave();
      refreshPreview();
    });

    fTags.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tag]');
      if (!btn) return;
      const id = btn.dataset.tag;
      const on = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', on ? 'false' : 'true');
      if (on) draft.tags = draft.tags.filter((t) => t !== id);
      else draft.tags.push(id);
      scheduleSave();
    });

    /* ── 사진 넣기 ───────────────────────────────────────
       고른 사진을 줄여 올리고, 커서 자리에 마크다운을 넣는다.
       방금 올린 사진은 CDN에 아직 없으므로 미리보기·썰네일은
       브라우저 안의 blob 주소로 바로 보여 준다. */

    const photoPick = document.getElementById('photoPick');
    const photoInput = document.getElementById('photoInput');
    const uploadStatus = document.getElementById('uploadStatus');
    const uploadStrip = document.getElementById('uploadStrip');
    const panes = form.querySelector('.editor-panes');
    const localPhotos = new Map(); // 'assets/uploads/...' → blob 주소
    let photoBusy = false;

    function paintLocalPhotos() {
      if (!localPhotos.size || !fPreview) return;
      fPreview.querySelectorAll('img').forEach((img) => {
        const key = String(img.getAttribute('src') || '').replace(/^\.\//, '');
        const local = localPhotos.get(key);
        if (local && img.getAttribute('src') !== local) img.setAttribute('src', local);
      });
    }

    function addThumb(url, name) {
      if (!uploadStrip) return;
      uploadStrip.hidden = false;
      const li = document.createElement('li');
      li.className = 'upload-thumb';
      li.title = name || '사진';
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      li.appendChild(img);
      uploadStrip.appendChild(li);
      uploadStrip.scrollLeft = uploadStrip.scrollWidth;
    }

    function photoErrorText(err, file) {
      if (err && (err.tooBig || err.notImage)) return err.message;
      return (file && file.name ? "'" + file.name + "' " : '사진 ') + '올리지 못했습니다. ' + apiErrorText(err);
    }

    function insertPhotoMarkdown(path) {
      const value = fBody.value;
      const start = typeof fBody.selectionStart === 'number' ? fBody.selectionStart : value.length;
      const end = typeof fBody.selectionEnd === 'number' ? fBody.selectionEnd : start;
      const next = insertPhotoBlock(value, start, end, photoMarkdown(path));
      fBody.value = next.value;
      if (fBody.setSelectionRange) fBody.setSelectionRange(next.caret, next.caret);
      scheduleSave();
      fBody.focus({ preventScroll: true });
    }

    async function handlePhotoFiles(fileList) {
      const files = Array.prototype.slice.call(fileList || []).filter(Boolean);
      if (!files.length) return;
      if (photoBusy) {
        if (uploadStatus) {
          uploadStatus.classList.remove('is-error');
          uploadStatus.textContent = '지금 사진을 올리고 있습니다. 끝나면 다시 넣어 주세요.';
        }
        return;
      }
      photoBusy = true;
      const total = files.length;
      let done = 0;
      let failure = '';
      for (let i = 0; i < total; i++) {
        if (uploadStatus) {
          uploadStatus.classList.remove('is-error');
          uploadStatus.textContent =
            total > 1 ? `사진 올리는 중... (${i + 1}/${total})` : '사진 올리는 중...';
        }
        try {
          const uploaded = await uploadPhoto(files[i]);
          const localUrl = URL.createObjectURL(uploaded.optimized.blob);
          localPhotos.set(uploaded.path, localUrl);
          addThumb(localUrl, files[i].name);
          insertPhotoMarkdown(uploaded.path);
          done++;
        } catch (err) {
          failure = photoErrorText(err, files[i]);
        }
      }
      photoBusy = false;
      if (uploadStatus) {
        if (failure) {
          uploadStatus.classList.add('is-error');
          uploadStatus.textContent =
            (done ? done + '장은 들어갔습니다. ' : '') +
            failure +
            (total > 1 && done ? ' (' + total + '장 중 ' + done + '장 완료)' : '');
        } else {
          uploadStatus.classList.remove('is-error');
          uploadStatus.textContent =
            (total > 1 ? done + '장' : '사진') +
            '을 넣었습니다. 설명은 ![ ] 안의 ‘' +
            DEFAULT_ALT +
            '’을 고치면 캡션으로 보입니다.';
        }
      }
      refreshPreview();
      scheduleSave();
    }

    if (photoPick && photoInput) {
      photoPick.addEventListener('click', () => {
        photoInput.value = '';
        photoInput.click();
      });
      photoInput.addEventListener('change', () => {
        // FileList는 인풋에 붙어 있는 살아 있는 목록이라, value를 비우기 전에 배열로 복사해야 한다.
        const picked = Array.prototype.slice.call(photoInput.files || []);
        photoInput.value = '';
        handlePhotoFiles(picked);
      });
    }

    fBody.addEventListener('paste', (e) => {
      const data = e.clipboardData;
      if (!data || !data.items) return;
      const files = [];
      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i];
        if (item.kind === 'file' && String(item.type || '').indexOf('image/') === 0) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length) {
        e.preventDefault();
        handlePhotoFiles(files);
      }
    });

    if (panes) {
      const hasFiles = (e) => {
        const types = e.dataTransfer && e.dataTransfer.types;
        return Boolean(types && Array.prototype.indexOf.call(types, 'Files') >= 0);
      };
      let dragDepth = 0;
      panes.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        panes.classList.add('is-dragover');
      });
      panes.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      panes.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) panes.classList.remove('is-dragover');
      });
      panes.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        panes.classList.remove('is-dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          handlePhotoFiles(e.dataTransfer.files);
        }
      });
    }

    form.querySelectorAll('.seg button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        form.dataset.view = view;
        form.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', b === btn ? 'true' : 'false'));
        refreshPreview();
        if (view !== 'write') fPreview.scrollTop = 0;
      });
    });

    const discard = form.querySelector('[data-draft="discard"]');
    if (discard) {
      discard.addEventListener('click', () => {
        clearDraftStore();
        const reset = isNew ? blankDraft() : draftFromPost(base);
        fTitle.value = reset.title;
        fSlug.value = reset.slug;
        fDate.value = reset.date;
        fExcerpt.value = reset.excerpt;
        fBody.value = reset.body;
        draft.tags = reset.tags.slice();
        fTags.querySelectorAll('button[data-tag]').forEach((b) => {
          b.setAttribute('aria-pressed', draft.tags.indexOf(b.dataset.tag) >= 0 ? 'true' : 'false');
        });
        const bar = document.getElementById('draftBar');
        if (bar) bar.remove();
        syncSlugHint();
        refreshPreview();
        if (draftNote) draftNote.textContent = '임시저장을 버렸습니다.';
      });
    }

    syncSlugHint();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (saveBtn.disabled) return;
      const current = read();
      const problem = validate(current);
      if (problem) {
        msg.textContent = problem;
        msg.classList.add('is-error');
        if (!SLUG_RE.test(current.slug)) fSlug.focus();
        else if (!current.title) fTitle.focus();
        return;
      }
      msg.classList.remove('is-error');
      msg.textContent = '';
      saveBtn.disabled = true;
      const label = saveBtn.textContent;
      saveBtn.textContent = '저장 중…';

      try {
        const result = await publish(current);
        if (result && result.cancelled) {
          saveBtn.disabled = false;
          saveBtn.textContent = label;
          return;
        }
        clearDraftStore();
        state.draft = null;
        disposed = true;
        if (saveTimer) clearTimeout(saveTimer);
        state.flush = null;
        invalidateSite();
        location.hash = '#/admin/done/' + encodeURIComponent(result.slug);
      } catch (err) {
        setApiError(msg, err);
        msg.classList.add('is-error');
        saveBtn.disabled = false;
        saveBtn.textContent = label;
      }
    });
  }

  function validate(d) {
    if (!d.title) return '제목을 넣어 주세요.';
    if (!d.slug) return '주소(슬러그)를 정해 주세요. 영문으로 짧게 쓰면 됩니다. 예: hello-world';
    if (!SLUG_RE.test(d.slug)) return '주소는 영문 소문자·숫자·하이픈만 쓸 수 있습니다. 예: hello-world';
    if (d.slug.length > 80) return '주소가 너무 깁니다. 80자 이하로 줄여 주세요.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return '날짜를 넣어 주세요.';
    if (!d.body.trim()) return '본문을 넣어 주세요.';
    return '';
  }

  function sortIndex(list) {
    return list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  async function publish(d) {
    const newPath = `posts/${d.slug}.md`;
    const body = d.body.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
    const slugChanged = !d.isNew && d.originalSlug && d.originalSlug !== d.slug;

    // 1) 본문 파일
    const existing = await getFile(newPath);
    if (existing && d.slug !== d.originalSlug) {
      if (!d.isNew) {
        const taken = new Error("'" + d.slug + "' 주소는 이미 다른 글에서 쓰고 있습니다. 다른 주소를 골라 주세요.");
        taken.slugTaken = true;
        throw taken;
      }
      const ok = window.confirm(`'${d.slug}' 주소에 이미 글이 있습니다. 그 글을 덮어쓸까요?`);
      if (!ok) return { cancelled: true };
    }
    const commitMessage = d.isNew ? `새 글: ${d.title}` : `글 수정: ${d.title}`;
    await putFile(newPath, body, existing ? existing.sha : null, commitMessage);

    // 2) 목록
    const indexFile = await getFile('posts.json');
    if (!indexFile) throw new Error('posts.json을 찾지 못했습니다.');
    let list = [];
    try {
      list = JSON.parse(indexFile.text);
    } catch (e) {
      list = [];
    }
    if (!Array.isArray(list)) list = [];

    const entry = { slug: d.slug, title: d.title, summary: d.excerpt, date: d.date, tags: d.tags.slice() };
    const at = list.findIndex((p) => p.slug === (d.originalSlug || d.slug));
    if (at >= 0) list[at] = Object.assign({}, list[at], entry);
    else list.push(entry);
    sortIndex(list);
    await putFile('posts.json', JSON.stringify(list, null, 2) + '\n', indexFile.sha, '글 목록 갱신');

    // 3) 주소를 바꿨다면 예전 파일 정리
    if (slugChanged) {
      try {
        const oldFile = await getFile(`posts/${d.originalSlug}.md`);
        if (oldFile) await deleteFile(`posts/${d.originalSlug}.md`, oldFile.sha, `주소 변경: ${d.originalSlug} → ${d.slug}`);
      } catch (e) {
        state.flash = { type: 'error', text: '글은 저장했지만 예전 주소의 파일을 지우지 못했습니다. GitHub에서 posts/' + d.originalSlug + '.md를 직접 지워 주세요.' };
      }
    }

    return { slug: d.slug };
  }

  /* ── 삭제 ─────────────────────────────────────────────── */

  async function removePost(slug, title) {
    const ok = window.confirm(`"${title}" 글을 지울까요?\n글이 완전히 사라지고 되돌릴 수 없습니다.`);
    if (!ok) return false;

    const file = await getFile(`posts/${slug}.md`);
    if (file) await deleteFile(`posts/${slug}.md`, file.sha, `글 삭제: ${title}`);

    const indexFile = await getFile('posts.json');
    if (!indexFile) throw new Error('posts.json을 찾지 못했습니다.');
    let list = [];
    try {
      list = JSON.parse(indexFile.text);
    } catch (e) {
      list = [];
    }
    if (!Array.isArray(list)) list = [];
    const next = list.filter((p) => p.slug !== slug);
    await putFile('posts.json', JSON.stringify(sortIndex(next), null, 2) + '\n', indexFile.sha, `글 목록 갱신: ${title} 삭제`);

    invalidateSite();
    state.flash = { type: 'ok', text: `"${title}" 글과 목록 항목을 지웠습니다. 사이트 반영까지 30초~1분 걸립니다.` };
    return true;
  }

  /* ── 화면 그리기 ──────────────────────────────────────── */

  async function render(root, route) {
    state.token = state.token || readToken();
    const sub = (route && route.sub) || '';

    if (!state.token) {
      renderLogin(root, '');
      return;
    }

    if (!state.session) {
      root.innerHTML = loadingView('로그인 확인 중…');
      try {
        const result = await verifyToken(state.token);
        if (!result.canWrite) {
          clearToken();
          renderLogin(root, '저장된 토큰에 쓰기 권한이 없습니다. 새 토큰으로 로그인해 주세요.');
          return;
        }
        state.session = result.user;
      } catch (err) {
        clearToken();
        renderLogin(root, apiErrorText(err));
        return;
      }
    }

    if (sub === 'new' || sub === 'edit') {
      await renderEditor(root, route);
      return;
    }

    await renderDashboard(root, sub === 'done' ? route.arg : '');
  }

  async function renderDashboard(root, doneSlug) {
    state.flush = null;
    root.innerHTML = loadingView('글 목록을 불러오는 중…');
    let index = [];
    let config = { goatcounterCode: '' };
    let failure = '';
    try {
      const results = await Promise.all([loadIndex(), loadConfig()]);
      index = results[0];
      config = results[1].config;
      state.index = index;
      state.config = config;
      state.configSha = results[1].sha;
    } catch (err) {
      failure = apiErrorText(err);
    }

    if (failure) {
      root.innerHTML = headHtml('관리', '') + errorView(failure);
      return;
    }

    root.innerHTML = dashboardHtml(index, config, doneSlug);
    document.title = '관리 · 전국';

    const logout = document.getElementById('adminLogout');
    if (logout) {
      logout.addEventListener('click', () => {
        clearToken();
        state.flash = null;
        render(root, { name: 'admin', sub: '', arg: '' });
      });
    }

    const list = document.querySelector('.admin-list');
    if (list) {
      list.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-delete]');
        if (!btn) return;
        btn.disabled = true;
        const label = btn.textContent;
        btn.textContent = '지우는 중…';
        try {
          const removed = await removePost(btn.dataset.delete, btn.dataset.title || btn.dataset.delete);
          if (removed) await renderDashboard(root, '');
          else {
            btn.disabled = false;
            btn.textContent = label;
          }
        } catch (err) {
          btn.disabled = false;
          btn.textContent = label;
          state.flash = { type: 'error', text: apiErrorText(err) };
          await renderDashboard(root, '');
        }
      });
    }

    const configForm = document.getElementById('adminConfig');
    if (configForm) {
      const codeInput = document.getElementById('adminCode');
      const disqusInput = document.getElementById('adminDisqus');
      const configMsg = document.getElementById('adminConfigMsg');
      const configBtn = configForm.querySelector('button[type="submit"]');
      configForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = codeInput.value.trim().toLowerCase();
        const shortname = disqusInput ? disqusInput.value.trim().toLowerCase() : (state.config.disqusShortname || '');
        if (code && !CODE_RE.test(code)) {
          configMsg.textContent = 'GoatCounter 코드는 영문 소문자·숫자·하이픈 3자 이상이어야 합니다. 예: jeonsul';
          configMsg.classList.add('is-error');
          return;
        }
        if (shortname && !CODE_RE.test(shortname)) {
          configMsg.textContent = 'Disqus shortname은 영문 소문자·숫자·하이픈 3자 이상이어야 합니다. 예: jeonsul';
          configMsg.classList.add('is-error');
          if (disqusInput) disqusInput.focus();
          return;
        }
        configMsg.classList.remove('is-error');
        configMsg.textContent = '';
        configBtn.disabled = true;
        configBtn.textContent = '저장 중…';
        try {
          // 기존 설정 값을 그대로 두고 두 항목만 바꿔 쓴다.
          const next = Object.assign({}, state.config, {
            goatcounterCode: code,
            disqusShortname: shortname,
          });
          const text = JSON.stringify(next, null, 2) + '\n';
          const changed = [];
          if (code !== (state.config.goatcounterCode || '')) changed.push(code ? `GoatCounter 코드 ${code}` : 'GoatCounter 해제');
          if (shortname !== (state.config.disqusShortname || '')) changed.push(shortname ? `Disqus ${shortname}` : 'Disqus 댓글 숨김');
          await putFile(
            'site-config.json',
            text,
            state.configSha,
            changed.length ? '사이트 설정: ' + changed.join(', ') : '사이트 설정 저장'
          );
          state.config = next;
          state.flash = {
            type: 'ok',
            text:
              (changed.length ? changed.join(' · ') + ' 설정을 저장했습니다.' : '설정을 저장했습니다.') +
              ' 사이트 반영까지 30초~1분 걸립니다.',
          };
          await renderDashboard(root, '');
        } catch (err) {
          setApiError(configMsg, err);
          configMsg.classList.add('is-error');
          configBtn.disabled = false;
          configBtn.textContent = '설정 저장';
        }
      });
    }

    if (config.goatcounterCode) loadStats(config.goatcounterCode, index);
  }

  async function renderEditor(root, route) {
    const isNew = route.sub === 'new';
    const slug = isNew ? '' : route.arg;
    root.innerHTML = loadingView(isNew ? '새 글을 준비하는 중…' : '글을 불러오는 중…');

    let base = null;
    if (!isNew) {
      try {
        base = await loadPostForEdit(slug);
      } catch (err) {
        root.innerHTML = headHtml('글 고치기', '') + errorView(apiErrorText(err));
        return;
      }
      if (!base) {
        root.innerHTML = headHtml('글 고치기', '') + errorView('그 주소의 글을 찾지 못했습니다. 목록에서 다시 골라 주세요.');
        return;
      }
    }

    const picked = pickDraft(base, isNew, slug);
    document.title = (isNew ? '새 글' : '글 고치기') + ' · 전국';
    root.innerHTML = editorHtml(picked.draft, isNew, picked.restored);
    wireEditor(root, picked.draft, isNew, base);
    const titleInput = document.getElementById('fTitle');
    if (isNew && titleInput) titleInput.focus();
  }

  window.BlogAdmin = {
    render: render,
    _test: {
      b64encode: b64encode,
      b64decode: b64decode,
      validate: validate,
      sortIndex: sortIndex,
      publish: publish,
      removePost: removePost,
      todayISO: todayISO,
      optimizePhoto: optimizePhoto,
      uploadPhoto: uploadPhoto,
      photoMarkdown: photoMarkdown,
      insertPhotoBlock: insertPhotoBlock,
      uploadFileName: uploadFileName,
      uploadDirStamp: uploadDirStamp,
      safeFileName: safeFileName,
      base64FromBytes: base64FromBytes,
      RE: { SLUG_RE: SLUG_RE, CODE_RE: CODE_RE },
      PHOTO: {
        EDGE: PHOTO_EDGE,
        QUALITY: PHOTO_QUALITY,
        MAX_BYTES: PHOTO_MAX_BYTES,
        ROOT: UPLOAD_ROOT,
        DEFAULT_ALT: DEFAULT_ALT,
      },
    },
  };
})();
