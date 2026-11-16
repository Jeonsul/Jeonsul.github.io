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
      out.push(`<h${level}>${renderInline(escapeHtml(h[2].trim()))}</h${level}>`);
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

/* ── views ───────────────────────────────────────────────── */

function entryHtml(post) {
  return `<li class="entry">
    <a href="#/post/${post.slug}">
      <time datetime="${post.date}">${formatDate(post.date)}</time>
      <h3>${escapeHtml(post.title)}</h3>
      <p class="summary">${escapeHtml(post.summary || '')}</p>
      <span class="tags">${(post.tags || []).map((t) => `<span>#${TAGS[t] || t}</span>`).join(' ')}</span>
    </a>
  </li>`;
}

function viewHome(posts, activeTag) {
  const filtered = activeTag ? posts.filter((p) => (p.tags || []).includes(activeTag)) : posts;
  const [featured, ...rest] = filtered;

  const chips = [
    `<a class="chip" href="#/" ${activeTag ? '' : 'aria-current="true"'}>전체</a>`,
    ...Object.entries(TAGS).map(
      ([id, label]) =>
        `<a class="chip" href="#/tag/${id}" ${activeTag === id ? 'aria-current="true"' : ''}>${label}</a>`
    ),
  ].join('');

  const hero = `
    <section class="hero fade-in">
      <p class="eyebrow"><span class="dot"></span>기록 · 2026</p>
      <h1>쌓아 두지 않으면<br>사라지는 것들을 <em>적어 둡니다</em>.</h1>
      <p>인공지능을 공부하고, 사진을 찍고, 음악을 모으는 사람의 노트. 잘 쓴 글보다 오래 남는 글을 목표로, 느리게 올립니다.</p>
    </section>`;

  if (!filtered.length) {
    return `${hero}<div class="filters">${chips}</div><p class="empty">이 주제의 글은 아직 없습니다.</p>`;
  }

  const feature = featured
    ? `<section class="featured fade-in">
        <a href="#/post/${featured.slug}">
          <span class="kicker">최근 글</span>
          <h2>${escapeHtml(featured.title)}</h2>
          <p>${escapeHtml(featured.summary || '')}</p>
          <span class="meta">
            <span>${formatDate(featured.date, true)}</span>
            <span class="sep">·</span>
            <span>${(featured.tags || []).map((t) => TAGS[t] || t).join(', ')}</span>
          </span>
        </a>
      </section>`
    : '';

  const list = rest.length
    ? `<section class="section-head"><h2>${activeTag ? TAGS[activeTag] : '모든 글'}</h2><a href="#/archive">전체 보기 →</a></section>
       <ul class="list">${rest.map(entryHtml).join('')}</ul>`
    : '';

  return `${hero}<div class="filters">${chips}</div>${feature}${list}`;
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
      <section class="year-group">
        <h2>${year}</h2>
        <ul class="list">${items.map(entryHtml).join('')}</ul>
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
      <div class="prose">${renderMarkdown(md)}</div>
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
      <p style="margin-top:1.4rem"><a href="#/" style="color:var(--accent);text-decoration:none">← 첫 화면으로</a></p>
    </header>`;
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

  if (!keepScroll) window.scrollTo({ top: 0, behavior: 'auto' });
  else updateProgress();

  wireCopyLink();
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

/* ── small interactions ──────────────────────────────────── */

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

const $toggle = document.getElementById('themeToggle');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch {}
  const dark = theme === 'dark';
  $toggle.setAttribute('aria-label', dark ? '라이트 모드로 전환' : '다크 모드로 전환');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0e0f11' : '#fbfaf7');
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

  window.goatcounter = window.goatcounter || {};
  window.goatcounter.no_onload = true; // 로드는 직접 한 번, 이동은 hashchange마다 센다

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://gc.zgo.at/count.js';
  script.setAttribute('data-goatcounter', `https://${code}.goatcounter.com/count`);
  script.addEventListener('load', () => {
    analyticsOn = true;
    countView();
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
