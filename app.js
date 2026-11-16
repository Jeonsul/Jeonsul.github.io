/* 전국 · 기록 — a small, dependency-free blog.
   Hash routing keeps it working on GitHub Pages subpaths without any build step. */

const TAGS = {
  ai: 'AI·개발',
  music: '음악',
  photo: '사진',
  life: '일상',
};

const $main = document.getElementById('main');
const $header = document.getElementById('siteHeader');
const $progress = document.getElementById('progress');
const $progressBar = $progress.querySelector('span');

let indexCache = null;
const postCache = new Map();
const prefetching = new Set();

/* ── helpers ─────────────────────────────────────────────── */

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function formatDate(iso, long = false) {
  const [y, m, d] = iso.split('-').map(Number);
  return long ? `${y}년 ${m}월 ${d}일` : `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`;
}

function readingTime(md) {
  const text = md.replace(/```[\s\S]*?```/g, '').replace(/[#>*_`\-\[\]()]/g, '');
  const chars = text.replace(/\s/g, '').length;
  return Math.max(1, Math.round(chars / 500));
}

function tagLinks(tags) {
  return (tags || [])
    .map((t) => `<a href="#/tag/${t}">${TAGS[t] || t}</a>`)
    .join(', ');
}

/* ── markdown (a deliberately small subset) ──────────────── */

let headingSeq = 0;

function renderInline(text) {
  let s = text;
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s;
}

function renderMarkdown(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  headingSeq = 0;
  const isBlockStart = (line) =>
    /^\s*(```|#{1,6}\s|>\s?|[-*+]\s|\d+\.\s)/.test(line) || /^\s*(-{3,}|\*{3,})\s*$/.test(line);

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // fenced code
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(
        `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`
      );
      continue;
    }

    // heading
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(6, Math.max(2, h[1].length)); // h1 is reserved for the post title
      const id = `sec-${headingSeq++}`;
      out.push(`<h${level} id="${id}">${renderInline(escapeHtml(h[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // lists
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = ordered ? cur.match(/^\s*\d+\.\s+(.*)$/) : cur.match(/^\s*[-*+]\s+(.*)$/);
        if (m) {
          items.push(m[1]);
          i++;
        } else if (cur.trim() && /^\s{2,}\S/.test(cur) && items.length) {
          items[items.length - 1] += ' ' + cur.trim(); // wrapped continuation line
          i++;
        } else {
          break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${renderInline(escapeHtml(t))}</li>`).join('')}</${tag}>`);
      continue;
    }

    // paragraph
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(escapeHtml(buf.join('\n')))}</p>`);
  }

  return out.join('\n');
}

/* ── data ────────────────────────────────────────────────── */

async function getIndex() {
  if (indexCache) return indexCache;
  const res = await fetch('./posts.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('posts.json ' + res.status);
  const posts = await res.json();
  posts.sort((a, b) => (a.date < b.date ? 1 : -1));
  indexCache = posts;
  return posts;
}

async function getPost(slug) {
  if (postCache.has(slug)) return postCache.get(slug);
  const res = await fetch(`./posts/${encodeURIComponent(slug)}.md`, { cache: 'no-cache' });
  if (!res.ok) throw new Error('post ' + res.status);
  const md = await res.text();
  postCache.set(slug, md);
  return md;
}

/* 본문 프리페치: 카드에 머물러 있는 동안 미리 읽어 클릭 시 즉시 전환 */
function prefetchPost(slug) {
  if (postCache.has(slug) || prefetching.has(slug)) return;
  prefetching.add(slug);
  getPost(slug).catch(() => prefetching.delete(slug));
}

/* 홈에 머무는 동안 전체 본문을 조용히 데워 둔다(검색·읽기 시간·즉시 전환용) */
function warmPosts(posts) {
  posts.forEach((p) => prefetchPost(p.slug));
}

/* ── thumbnails & illustration (inline SVG, 외부 의존성 0) ── */

function thumbSvg(kind) {
  const stroke = 'stroke="#3182F6" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  const fill = 'fill="#E8F3FF"';
  if (kind === 'music') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path class="st" d="M12.5 23.5V9.2l10-2v13.6" fill="none" ${stroke}/><circle class="st" cx="10" cy="23.5" r="2.7" fill="none" ${stroke}/><circle class="st" cx="20" cy="20.8" r="2.7" fill="none" ${stroke}/></svg>`;
  }
  if (kind === 'photo') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect class="st" x="4" y="9" width="24" height="17" rx="3.5" fill="none" ${stroke}/><path class="st" d="M11.5 9l1.8-3h5.4l1.8 3" fill="none" ${stroke}/><circle class="st" cx="16" cy="17.5" r="4.6" fill="none" ${stroke}/></svg>`;
  }
  if (kind === 'ai') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect class="st" x="9" y="9" width="14" height="14" rx="3" fill="none" ${stroke}/><path class="st" d="M16 3.5V9M16 23v5.5M3.5 16H9M23 16h5.5" fill="none" ${stroke}/><circle class="st" cx="16" cy="16" r="2.6" fill="none" ${stroke}/></svg>`;
  }
  if (kind === 'life') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path class="st" d="M6 22c0-6 4.5-13 10-13s10 7 10 13" fill="none" ${stroke}/><path class="st" d="M6 22h20" fill="none" ${stroke}/><circle class="st" cx="16" cy="26" r="1.6" ${stroke}/></svg>`;
  }
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect class="st" x="7" y="5" width="18" height="22" rx="3.5" fill="none" ${stroke}/><path class="st" d="M11.5 11h9M11.5 16h9M11.5 21h5.5" fill="none" ${stroke}/></svg>`;
}

function tagThumb(tags) {
  const t = (tags || []).find((x) => TAGS[x]);
  return thumbSvg(t || 'doc');
}

function tagOf(post) {
  return (post.tags || []).find((t) => TAGS[t]) || null;
}

function heroArtSvg() {
  return `<svg viewBox="0 0 420 320" role="img" aria-label="">
    <defs>
      <linearGradient id="ga" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#3182F6" stop-opacity="0.92"/>
        <stop offset="1" stop-color="#1B64DA" stop-opacity="0.92"/>
      </linearGradient>
      <linearGradient id="gb" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.95"/>
        <stop offset="1" stop-color="#E8F3FF" stop-opacity="0.9"/>
      </linearGradient>
    </defs>
    <circle cx="96" cy="120" r="58" fill="url(#ga)"/>
    <circle cx="96" cy="120" r="58" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2"/>
    <path d="M60 132c10-14 20-20 30-20" stroke="#ffffff" stroke-width="7" stroke-linecap="round" fill="none" opacity="0.85"/>
    <rect x="168" y="52" width="180" height="116" rx="24" fill="url(#gb)"/>
    <rect x="168" y="52" width="180" height="116" rx="24" fill="none" stroke="#3182F6" stroke-opacity="0.25" stroke-width="2"/>
    <rect x="192" y="80" width="104" height="12" rx="6" fill="#3182F6" opacity="0.75"/>
    <rect x="192" y="104" width="132" height="12" rx="6" fill="#3182F6" opacity="0.35"/>
    <rect x="192" y="128" width="76" height="12" rx="6" fill="#3182F6" opacity="0.22"/>
    <rect x="120" y="196" width="200" height="84" rx="22" fill="#ffffff"/>
    <rect x="120" y="196" width="200" height="84" rx="22" fill="none" stroke="#3182F6" stroke-opacity="0.25" stroke-width="2"/>
    <circle cx="158" cy="238" r="18" fill="#3182F6"/>
    <path d="M151 238l5 5 9-11" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <rect x="188" y="222" width="104" height="11" rx="5.5" fill="#3182F6" opacity="0.5"/>
    <rect x="188" y="243" width="72" height="11" rx="5.5" fill="#3182F6" opacity="0.25"/>
    <path d="M330 160l6 14 14 6-14 6-6 14-6-14-14-6 14-6z" fill="#3182F6" opacity="0.8"/>
    <circle cx="376" cy="96" r="10" fill="#3182F6" opacity="0.35"/>
    <circle cx="52" cy="236" r="7" fill="#3182F6" opacity="0.3"/>
  </svg>`;
}

/* ── views ───────────────────────────────────────────────── */

function cardHtml(post) {
  const t = tagOf(post);
  return `<li class="card reveal${t ? '' : ' is-uncategorized'}" data-slug="${escapeHtml(post.slug)}">
    <a href="#/post/${encodeURIComponent(post.slug)}" data-slug="${escapeHtml(post.slug)}">
      <div class="card-top">
        <span class="card-cat">${t ? TAGS[t] : '기록'}</span>
        <span class="card-thumb" aria-hidden="true">${tagThumb(post.tags)}</span>
      </div>
      <h3>${escapeHtml(post.title)}</h3>
      <p class="summary">${escapeHtml(post.summary || '')}</p>
      <span class="card-meta">
        <time datetime="${post.date}">${formatDate(post.date)}</time>
        <span class="sep">·</span>
        <span class="rt" data-rt="${escapeHtml(post.slug)}">읽는 중…</span>
      </span>
    </a>
  </li>`;
}

function sidebarHtml(posts) {
  const latest = posts.slice(0, 3);
  const pop = latest
    .map(
      (p, i) => `<li>
        <a href="#/post/${encodeURIComponent(p.slug)}" data-slug="${escapeHtml(p.slug)}">
          <span class="pop-rank">${i + 1}</span>
          <span class="pop-title">${escapeHtml(p.title)}</span>
        </a>
        <span class="pop-meta" data-pop="${escapeHtml(p.slug)}">조회수 집계 중…</span>
      </li>`
    )
    .join('');

  const topics = Object.entries(TAGS)
    .map(([id, label]) => {
      const n = posts.filter((p) => (p.tags || []).includes(id)).length;
      return `<li><a href="#/tag/${id}"><span>${label}</span><span class="topic-count">${n}</span></a></li>`;
    })
    .join('');

  return `<aside class="sidebar" aria-label="사이드바">
    <section class="side-card reveal">
      <h2 class="side-title">인기 있는 글</h2>
      <ol class="pop-list" id="popList">${pop}</ol>
    </section>
    <section class="side-card reveal">
      <h2 class="side-title">주제 모아보기</h2>
      <ul class="topic-list">${topics}</ul>
    </section>
    <section class="side-card side-about reveal">
      <h2 class="side-title">이 블로그는</h2>
      <p>인공지능을 공부하고, 사진을 찍고, 음악을 모으는 사람의 느린 노트입니다.</p>
      <a class="btn btn-primary" href="#/about">소개 더 보기</a>
    </section>
  </aside>`;
}

function homeShell(posts, activeTag, innerHtml) {
  return `
    <section class="hero reveal">
      <div class="hero-copy">
        <p class="hero-eyebrow"><span class="dot"></span>기록 · 2026</p>
        <h1>쌓아 두지 않으면<br>사라지는 것들을 <em>적어 둡니다</em>.</h1>
        <p class="hero-sub">인공지능을 공부하고, 사진을 찍고, 음악을 모으는 사람의 노트. 잘 쓴 글보다 오래 남는 글을 목표로, 느리게 올립니다.</p>
        <div class="hero-cta">
          <a class="btn btn-primary btn-lg" href="#/post/${encodeURIComponent(posts[0] ? posts[0].slug : '')}">최근 글 읽기</a>
          <a class="btn btn-ghost btn-lg" href="#/about">소개 보기</a>
        </div>
      </div>
      <div class="hero-art" aria-hidden="true">${heroArtSvg()}</div>
    </section>
    <div class="home-grid">
      <div class="home-main">
        <div class="list-tools">
          <div class="search-box" id="searchBox">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5"></circle>
              <path d="m16.2 16.2 4.3 4.3"></path>
            </svg>
            <input id="postSearch" type="search" placeholder="제목·내용에서 찾기" aria-label="글 검색" autocomplete="off">
            <button class="search-clear" id="searchClear" type="button" aria-label="검색 지우기">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5 5 19"></path></svg>
            </button>
            <span class="search-kbd" aria-hidden="true">/</span>
          </div>
          <div class="tag-seg" role="group" aria-label="주제 필터">
            <a class="seg-item" href="#/" ${activeTag ? '' : 'aria-current="true"'}>전체</a>
            ${Object.entries(TAGS)
              .map(
                ([id, label]) =>
                  `<a class="seg-item" href="#/tag/${id}" ${activeTag === id ? 'aria-current="true"' : ''}>${label}</a>`
              )
              .join('')}
          </div>
        </div>
        ${innerHtml}
      </div>
      ${sidebarHtml(posts)}
    </div>`;
}

function viewHome(posts, activeTag) {
  const filtered = activeTag ? posts.filter((p) => (p.tags || []).includes(activeTag)) : posts;

  if (!filtered.length) {
    return homeShell(
      posts,
      activeTag,
      `<p class="empty">이 주제의 글은 아직 없습니다.</p><p class="empty no-result" id="noResult">검색 결과가 없습니다.</p>`
    );
  }

  const featured = filtered[0];
  const rest = filtered.slice(1);

  const feature = `
    <section class="featured reveal">
      <a href="#/post/${encodeURIComponent(featured.slug)}" data-slug="${escapeHtml(featured.slug)}">
        <span class="kicker">최근 글</span>
        <h2>${escapeHtml(featured.title)}</h2>
        <p>${escapeHtml(featured.summary || '')}</p>
        <span class="meta">
          <span>${formatDate(featured.date, true)}</span>
          <span class="sep">·</span>
          <span class="rt" data-rt="${escapeHtml(featured.slug)}">읽는 중…</span>
          ${(featured.tags || []).length ? `<span class="sep">·</span><span>${featured.tags.map((t) => TAGS[t] || t).join(', ')}</span>` : ''}
        </span>
      </a>
    </section>`;

  const list = rest.length
    ? `<section class="section-head"><h2>${activeTag ? TAGS[activeTag] : '모든 글'}</h2><a href="#/archive">전체 보기 →</a></section>
       <ul class="card-grid" id="postList">${rest.map(cardHtml).join('')}</ul>
       <p class="empty no-result" id="noResult">검색 결과가 없습니다.</p>`
    : `<p class="empty no-result" id="noResult">검색 결과가 없습니다.</p>`;

  return homeShell(posts, activeTag, feature + list);
}

function viewArchive(posts) {
  const byYear = new Map();
  posts.forEach((p) => {
    const y = p.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p);
  });

  const groups = [...byYear.entries()]
    .map(
      ([year, items]) => `
      <section class="year-group reveal">
        <h2>${year}</h2>
        <ul class="card-grid">${items.map(cardHtml).join('')}</ul>
      </section>`
    )
    .join('');

  return `
    <header class="page-head fade-in">
      <h1>기록</h1>
      <p>지금까지 올린 글 ${posts.length}편. 날짜 순으로 정리했습니다.</p>
    </header>
    ${groups}`;
}

function viewAbout() {
  return `
    <header class="page-head fade-in">
      <h1>소개</h1>
      <p>짧게 쓴 자기소개. 길게 쓰면 어색해져서 여기까지만.</p>
    </header>
    <div class="about fade-in">
      <p class="lead">전국입니다. 인공지능을 공부하고, 사진을 찍고, 음악을 모읍니다.</p>
      <p>컴퓨터가 스스로 판단하는 방식을 배우는 일이 재미있어서 인공지능학과에 들어갔습니다. 배운 것을 그대로 두면 금방 사라져서, 이해한 만큼만 내 말로 다시 적어 두는 습관을 들이는 중입니다. 이 블로그는 그 기록이 쌓이는 곳입니다.</p>
      <p>공부 밖에서는 카메라를 들고 다니고, 러닝할 때 들을 일본 음악을 고릅니다. 잘 찍지 못해도 빛이 좋은 순간을 남기는 걸 좋아하고, 노래는 한 곡을 몇십 번씩 반복해서 듣는 편입니다.</p>

      <h2>관심사</h2>
      <dl>
        <dt>AI · 컴퓨터공학</dt>
        <dd>머신러닝 기초, 언어 모델, 그리고 배운 것을 직접 돌려 보는 작은 프로젝트.</dd>
        <dt>사진</dt>
        <dd>미러리스 한 대와 표준 줌 렌즈. 여행보다 동네 골목에서 더 많이 찍습니다.</dd>
        <dt>음악</dt>
        <dd>요네즈 켄시, 요루시카, 나토리, 와누카. 러닝용 플레이리스트를 계속 고치는 중입니다.</dd>
        <dt>만드는 일</dt>
        <dd>웹, 자동화 스크립트, 쓸모는 작지만 기분 좋은 도구들.</dd>
      </dl>

      <h2>이 블로그에 대해</h2>
      <p>화려한 글보다 읽기 편한 글을 쓰려고 합니다. 광고는 넣지 않고, 다른 곳에 쓴 글도 이곳에 모아 둘 예정입니다. 글은 마크다운 파일 하나로 추가되고, 모든 기록은 공개된 것만 올라옵니다.</p>

      <h2>연결</h2>
      <p class="links">
        <a href="https://github.com/Jeonsul" target="_blank" rel="noopener">GitHub</a>
        <a href="#/archive">글 목록</a>
      </p>
    </div>`;
}

async function viewPost(posts, slug) {
  const post = posts.find((p) => p.slug === slug);
  if (!post) return viewMissing('그 글을 찾을 수 없습니다.');

  const md = await getPost(slug);
  const i = posts.findIndex((p) => p.slug === slug);
  const newer = i > 0 ? posts[i - 1] : null;
  const older = i < posts.length - 1 ? posts[i + 1] : null;
  const minutes = readingTime(md);

  return `
    <article class="post fade-in">
      <a class="post-back" href="#/">← 글 목록</a>
      <header class="post-header">
        <h1>${escapeHtml(post.title)}</h1>
        <div class="post-meta">
          <time datetime="${post.date}">${formatDate(post.date, true)}</time>
          <span class="sep">·</span>
          <span>${minutes}분 읽기</span>
          <span class="sep">·</span>
          <span class="post-tags">${tagLinks(post.tags)}</span>
          <button class="copy-link" type="button" id="copyLink">링크 복사</button>
        </div>
      </header>
      <div class="prose" id="prose">${renderMarkdown(md)}</div>
      <nav class="post-footer" aria-label="다른 글">
        ${
          older
            ? `<a class="post-nav prev" href="#/post/${older.slug}"><span class="label">이전 글</span><span class="title">${escapeHtml(older.title)}</span></a>`
            : '<span class="post-nav is-empty"></span>'
        }
        ${
          newer
            ? `<a class="post-nav next" href="#/post/${newer.slug}"><span class="label">다음 글</span><span class="title">${escapeHtml(newer.title)}</span></a>`
            : '<span class="post-nav is-empty"></span>'
        }
      </nav>
    </article>`;
}

function viewMissing(message) {
  return `
    <header class="page-head fade-in">
      <h1>없는 페이지</h1>
      <p>${escapeHtml(message)} 주소가 바뀌었거나 오타일 수 있습니다.</p>
      <p><a class="btn btn-primary" href="#/">첫 화면으로</a></p>
    </header>`;
}

/* ── post-page enhancers ─────────────────────────────────── */

function buildToc() {
  const prose = document.getElementById('prose');
  const article = document.querySelector('.post');
  if (!prose || !article) return;
  const heads = [...prose.querySelectorAll('h2, h3')];
  if (heads.length < 2) return;
  const items = heads
    .map((h) => `<li><a class="toc-h${h.tagName.toLowerCase()}" href="#${h.id}">${h.textContent}</a></li>`)
    .join('');
  const nav = document.createElement('nav');
  nav.className = 'toc fade-in';
  nav.setAttribute('aria-label', '목차');
  nav.innerHTML = `<p class="toc-title">목차</p><ol>${items}</ol>`;
  prose.before(nav);

  nav.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const el = document.getElementById(a.getAttribute('href').slice(1));
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', a.getAttribute('href'));
  });
}

function wireCodeCopy() {
  document.querySelectorAll('.prose pre').forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains('codeblock')) return;
    const box = document.createElement('div');
    box.className = 'codeblock';
    pre.replaceWith(box);
    box.appendChild(pre);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.setAttribute('aria-label', '코드 복사');
    btn.textContent = '복사';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        btn.textContent = '복사됨 ✓';
        btn.classList.add('is-done');
      } catch {
        btn.textContent = '복사 실패';
      }
      setTimeout(() => {
        btn.textContent = '복사';
        btn.classList.remove('is-done');
      }, 1600);
    });
    box.appendChild(btn);
  });
}

function wireCopyLink() {
  const btn = document.getElementById('copyLink');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = '복사됨';
    } catch {
      btn.textContent = '주소를 복사하세요';
    }
    setTimeout(() => { btn.textContent = original; }, 1600);
  });
}

/* ── home enhancements ───────────────────────────────────── */

function fillReadingTimes() {
  getIndex()
    .then((posts) => {
      posts.forEach(async (p) => {
        const el = document.querySelector(`[data-rt="${CSS.escape ? CSS.escape(p.slug) : p.slug}"]`);
        if (!el) return;
        try {
          const md = await getPost(p.slug);
          el.textContent = `${readingTime(md)}분 읽기`;
        } catch {
          el.textContent = '';
        }
      });
    })
    .catch(() => {});
}

/* GoatCounter 조회수로 '인기 있는 글' 순위를 다시 짠다(실패 시 최신 3편 유지). */
async function rankPopular() {
  const list = document.getElementById('popList');
  if (!list || !analyticsOn) return;
  const posts = (indexCache || []).slice(0, 5);
  if (!posts.length) return;

  const results = await Promise.all(
    posts.map(async (p) => {
      const path = '#/post/' + p.slug;
      try {
        const r = await requestCountPath(path);
        return { slug: p.slug, title: p.title, count: r };
      } catch (e) {
        return null;
      }
    })
  );
  const ok = results.filter(Boolean);
  if (ok.length < 2) return; // 표본이 너무 적으면 그대로 둔다

  ok.sort((a, b) => Number(b.count) - Number(a.count));
  const top = ok.slice(0, 3);
  list.innerHTML = top
    .map(
      (r, i) => `<li>
        <a href="#/post/${encodeURIComponent(r.slug)}" data-slug="${escapeHtml(r.slug)}">
          <span class="pop-rank">${i + 1}</span>
          <span class="pop-title">${escapeHtml(r.title)}</span>
        </a>
        <span class="pop-meta">조회 ${escapeHtml(r.count)}</span>
      </li>`
    )
    .join('');
}

async function requestCountPath(path) {
  const res = await fetch(`https://${goatcounterCode}.goatcounter.com/counter/${encodeURIComponent(path)}.json`, { cache: 'no-store' });
  if (res.status === 404) return '0'; // 아직 집계 전인 글은 0으로 본다
  if (!res.ok) throw new Error('counter ' + res.status);
  const data = await res.json();
  return String(data && data.count != null ? data.count : '0');
}

function wireSearch() {
  const input = document.getElementById('postSearch');
  const box = document.getElementById('searchBox');
  const clear = document.getElementById('searchClear');
  const noResult = document.getElementById('noResult');
  if (!input || !box) return;

  const apply = () => {
    const q = input.value.trim().toLowerCase();
    const cards = document.querySelectorAll('#postList .card, .featured');
    let visible = 0;
    cards.forEach((el) => {
      const slug = el.dataset.slug || (el.querySelector('a') && el.querySelector('a').dataset.slug);
      const post = (indexCache || []).find((p) => p.slug === slug);
      if (!post) return;
      const body = postCache.get(slug) || '';
      const hay = (post.title + ' ' + (post.summary || '') + ' ' + (post.tags || []).map((t) => TAGS[t] || t).join(' ') + ' ' + body).toLowerCase();
      const hit = !q || hay.indexOf(q) >= 0;
      el.classList.toggle('is-hidden', !hit);
      if (hit) visible++;
    });
    if (noResult) noResult.classList.toggle('is-on', q && visible === 0);
    box.classList.toggle('has-value', Boolean(q));
    if (clear) clear.classList.toggle('is-on', Boolean(q));
  };

  input.addEventListener('input', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      apply();
      input.blur();
    }
  });
  if (clear) {
    clear.addEventListener('click', () => {
      input.value = '';
      apply();
      input.focus();
    });
  }
}

/* '/' 단축키와 헤더 검색 버튼 */
let pendingSearchFocus = false;

function focusSearch() {
  const input = document.getElementById('postSearch');
  if (input) {
    input.focus();
    input.select();
    return true;
  }
  return false;
}

document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (typing) return;
  if (focusSearch()) e.preventDefault();
  else {
    pendingSearchFocus = true;
    if (parseRoute().name !== 'home') location.hash = '#/';
  }
});

const searchBtn = document.getElementById('searchBtn');
if (searchBtn) {
  searchBtn.addEventListener('click', () => {
    if (!focusSearch()) {
      pendingSearchFocus = true;
      if (parseRoute().name !== 'home') location.hash = '#/';
      else pendingSearchFocus = false;
    }
  });
}

/* 본문 프리페치: 카드 hover/포커스만으로 미리 읽기 */
document.addEventListener('mouseover', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="#/post/"]');
  if (a && a.dataset.slug) prefetchPost(a.dataset.slug);
}, { passive: true });
document.addEventListener('focusin', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="#/post/"]');
  if (a && a.dataset.slug) prefetchPost(a.dataset.slug);
});

/* ── scroll reveal ───────────────────────────────────────── */

let revealObserver = null;

function wireReveal() {
  const els = document.querySelectorAll('.reveal:not(.is-in)');
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }
  if (!revealObserver) {
    revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add('is-in');
            revealObserver.unobserve(en.target);
          }
        });
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.04 }
    );
  }
  els.forEach((el) => revealObserver.observe(el));
}

/* ── router ──────────────────────────────────────────────── */

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'post' && parts[1]) return { name: 'post', slug: parts[1] };
  if (parts[0] === 'tag' && parts[1]) return { name: 'home', tag: parts[1] };
  if (parts[0] === 'archive') return { name: 'archive' };
  if (parts[0] === 'about') return { name: 'about' };
  if (parts[0] === 'admin') return { name: 'admin', sub: parts[1] || '', arg: parts[2] || '' };
  return { name: 'missing' };
}

function setActiveNav(route) {
  document.querySelectorAll('.nav a[data-nav]').forEach((a) => {
    const key = a.dataset.nav;
    const active = (route.name === 'home' && key === 'home') || route.name === key;
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

async function render({ keepScroll = false } = {}) {
  const route = parseRoute();
  setActiveNav(route);

  if (route.name === 'admin' && window.BlogAdmin) {
    document.body.classList.remove('is-post');
    document.title = '관리 · 전국';
    $progress.classList.remove('is-on');
    await window.BlogAdmin.render($main, route);
    if (!keepScroll) window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }

  let html = '';
  let title = '전국 · 기록';

  try {
    if (route.name === 'home') {
      const posts = await getIndex();
      warmPosts(posts);
      html = viewHome(posts, route.tag);
      title = route.tag ? `${TAGS[route.tag] || '글'} · 전국` : '전국 · 기록';
    } else if (route.name === 'archive') {
      const posts = await getIndex();
      html = viewArchive(posts);
      title = '기록 · 전국';
    } else if (route.name === 'about') {
      html = viewAbout();
      title = '소개 · 전국';
    } else if (route.name === 'post') {
      const posts = await getIndex();
      html = await viewPost(posts, route.slug);
      const post = posts.find((p) => p.slug === route.slug);
      if (post) title = `${post.title} · 전국`;
    } else {
      html = viewMissing('그 주소에 해당하는 글이 없습니다.');
    }
  } catch (err) {
    console.error(err);
    html = viewMissing('글을 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.');
  }

  $main.innerHTML = html;
  document.title = title;
  document.body.classList.toggle('is-post', route.name === 'post');

  if (!keepScroll) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    $main.focus({ preventScroll: true });
  } else {
    updateProgress();
  }

  wireCopyLink();
  wireCodeCopy();
  buildToc();
  wireReveal();

  if (route.name === 'home') {
    wireSearch();
    fillReadingTimes();
    rankPopular();
    if (pendingSearchFocus) {
      pendingSearchFocus = false;
      focusSearch();
    }
  } else {
    pendingSearchFocus = false;
  }
}

/* ── reading progress ────────────────────────────────────── */

function updateProgress() {
  const article = document.querySelector('.post');
  if (!article) {
    $progress.classList.remove('is-on');
    return;
  }
  $progress.classList.add('is-on');
  const rect = article.getBoundingClientRect();
  const total = rect.height - window.innerHeight * 0.55;
  const passed = -rect.top + window.innerHeight * 0.25;
  const pct = total > 0 ? Math.min(100, Math.max(0, (passed / total) * 100)) : 0;
  $progressBar.style.width = pct + '%';
}

/* ── theme ───────────────────────────────────────────────── */

const $toggle = document.getElementById('themeToggle');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch {}
  const dark = theme === 'dark';
  $toggle.setAttribute('aria-label', dark ? '라이트 모드로 전환' : '다크 모드로 전환');
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  const color = dark ? '#101013' : '#ffffff';
  metas.forEach((m) => m.setAttribute('content', color));
}

if ($toggle) {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  $toggle.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
}

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let saved = null;
    try { saved = localStorage.getItem('theme'); } catch {}
    if (!saved) applyTheme(e.matches ? 'dark' : 'light');
  });
}

window.addEventListener('scroll', () => {
  $header.classList.toggle('is-scrolled', window.scrollY > 6);
  updateProgress();
}, { passive: true });

window.addEventListener('hashchange', () => {
  render();
  countView();
});
window.addEventListener('resize', updateProgress);

document.getElementById('year').textContent = new Date().getFullYear();

/* ── 방문자 통계 (GoatCounter) ─────────────────────────────
   site-config.json의 goatcounterCode가 채워져 있을 때만 켜집니다.
   해시 라우팅이라 hashchange마다 현재 화면을 직접 세어 줍니다. */

const GOATCOUNTER_RE = /^[a-z0-9][a-z0-9-]{1,49}$/;
let analyticsOn = false;
let goatcounterCode = '';

function countView() {
  if (!analyticsOn) return;
  if (location.hash.indexOf('#/admin') === 0) return; // 내 관리 화면은 세지 않는다
  const gc = window.goatcounter;
  if (gc && typeof gc.count === 'function') gc.count({ path: location.hash || '#/' });
}

async function startAnalytics() {
  let config = null;
  try {
    const res = await fetch('./site-config.json', { cache: 'no-store' });
    if (!res.ok) return;
    config = await res.json();
  } catch (e) {
    return;
  }
  const code = config && typeof config.goatcounterCode === 'string' ? config.goatcounterCode.trim().toLowerCase() : '';
  if (!GOATCOUNTER_RE.test(code)) return;
  goatcounterCode = code;

  window.goatcounter = window.goatcounter || {};
  window.goatcounter.no_onload = true; // 로드는 직접 한 번, 이동은 hashchange마다 센다

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://gc.zgo.at/count.js';
  script.setAttribute('data-goatcounter', `https://${code}.goatcounter.com/count`);
  script.addEventListener('load', () => {
    analyticsOn = true;
    countView();
    if (parseRoute().name === 'home') rankPopular();
  });
  script.addEventListener('error', () => {
    analyticsOn = false;
  });
  document.head.appendChild(script);
}

// 관리자 화면에서 쓸 수 있도록 캐시를 밖에서도 비울 수 있게 둔다.
window.blogData = {
  getIndex,
  getPost,
  invalidate() {
    indexCache = null;
    postCache.clear();
  },
};

render();
startAnalytics();
