/* ═══════════════════════════════════════════════════
   Mainspring News — Content Routing & Rendering
   Shared by: index.html, reviews.html, article.html,
              and news.html (for original-content prepend)

   content.json schema per item:
     id       – unique integer, used in ?id= URL param
     type     – "article" | "review"
     status   – "published" | "draft"  (drafts are hidden)
     featured – true | false  (first true item becomes hero)
     title    – string
     author   – string
     date     – ISO date string "YYYY-MM-DD"
     image    – URL string, or "" for placeholder
     excerpt  – short teaser (shown in cards + hero)
     body     – full HTML content (shown only on article.html)
     tags     – array of strings
     readTime – "X min read" string
   ═══════════════════════════════════════════════════ */

const CONTENT_URL     = './content.json';
const PLACEHOLDER_IMG = 'https://mainspring.news/coil-icon.png';

// ══════════════════════════════════
//  Utilities
// ══════════════════════════════════
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

function urlParam(name) {
    return new URLSearchParams(window.location.search).get(name);
}

function fmtDate(str) {
    const d = new Date(str);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtDateShort(str) {
    const d = new Date(str);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ══════════════════════════════════
//  Fetch
// ══════════════════════════════════
async function fetchContent() {
    try {
        const res = await fetch(CONTENT_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // Only return published items, newest first
        return Array.isArray(data)
            ? data
                .filter(i => i.status === 'published')
                .sort((a, b) => new Date(b.date) - new Date(a.date))
            : [];
    } catch (e) {
        console.error('[Content] Failed to load content.json:', e);
        return [];
    }
}

// ══════════════════════════════════
//  HTML Builders
// ══════════════════════════════════
function buildHeroHTML(item) {
    const img        = item.image && item.image.trim() ? item.image : null;
    const articleUrl = `article.html?id=${item.id}`;
    const badge      = item.type === 'review' ? 'Review' : 'Featured';

    return `
    <section class="hero-section">
        <a class="hero-link" href="${esc(articleUrl)}">
            <div class="hero-image-wrap">
                ${img
                    ? `<img src="${esc(img)}" alt="${esc(item.title)}"
                            onerror="this.parentNode.innerHTML='<div class=\\'hero-placeholder\\'><img src=\\'${PLACEHOLDER_IMG}\\' alt=\\'\\'></div>'">`
                    : `<div class="hero-placeholder"><img src="${PLACEHOLDER_IMG}" alt=""></div>`
                }
                <div class="hero-overlay"></div>
                <span class="hero-badge">${badge}</span>
            </div>
            <div class="hero-body">
                <h1 class="hero-title">${esc(item.title)}</h1>
                <p class="hero-excerpt">${esc(item.excerpt || '')}</p>
                <div class="hero-meta">
                    <span class="hero-date">${fmtDate(item.date)}</span>
                    ${item.readTime ? `<span class="hero-sep">·</span>
                    <span class="hero-read">${esc(item.readTime)}</span>` : ''}
                </div>
                <span class="hero-cta">Read Article →</span>
            </div>
        </a>
    </section>`;
}

function buildCardHTML(item, animIndex) {
    const img        = item.image && item.image.trim() ? item.image : null;
    const articleUrl = `article.html?id=${item.id}`;

    const imgContent = img
        ? `<img src="${esc(img)}" alt="" loading="lazy"
                onerror="this.parentNode.innerHTML='<div class=\\'card-image-placeholder\\'><img src=\\'${PLACEHOLDER_IMG}\\' alt=\\'\\'></div>'">`
        : `<div class="card-image-placeholder"><img src="${PLACEHOLDER_IMG}" alt=""></div>`;

    const badge = item.type === 'review' ? 'Review' : 'Mainspring';

    return `
    <article class="article-card" style="animation-delay:${Math.min(animIndex * 0.04, 0.5)}s">
        <a class="card-image-container" href="${esc(articleUrl)}">
            ${imgContent}
            <span class="card-source">${badge}</span>
        </a>
        <div class="card-body">
            <h2 class="card-headline">
                <a href="${esc(articleUrl)}">${esc(item.title)}</a>
            </h2>
            <p class="card-summary">${esc(item.excerpt || '')}</p>
            <div class="card-footer">
                <span class="card-date">${fmtDateShort(item.date)}</span>
                ${item.readTime ? `<span class="card-read-time">${esc(item.readTime)}</span>` : ''}
            </div>
        </div>
    </article>`;
}

// ══════════════════════════════════
//  Page Renderers
// ══════════════════════════════════

/*
 * renderContentPage(type)
 * Called by index.html ('article') and reviews.html ('review').
 * Expects these elements in the DOM:
 *   #contentSkeleton – hidden after load
 *   #contentHero     – receives the hero card
 *   #contentGrid     – receives the article grid
 */
async function renderContentPage(type) {
    const skeletonEl = document.getElementById('contentSkeleton');
    const heroEl     = document.getElementById('contentHero');
    const gridEl     = document.getElementById('contentGrid');

    const all   = await fetchContent();
    const items = all.filter(i => i.type === type);

    if (skeletonEl) skeletonEl.style.display = 'none';

    if (items.length === 0) {
        const label = type === 'review' ? 'reviews' : 'articles';
        if (heroEl) heroEl.innerHTML = '';
        if (gridEl) gridEl.innerHTML = `
            <div class="no-results">
                <h3>Nothing here yet</h3>
                <p>No ${label} published yet — check back soon.</p>
            </div>`;
        return;
    }

    // Hero: first featured item, falling back to most recent
    const featured = items.find(i => i.featured) || items[0];
    if (heroEl) heroEl.innerHTML = buildHeroHTML(featured);

    // Grid: everything that isn't the hero
    const rest = items.filter(i => i.id !== featured.id);
    if (gridEl) {
        gridEl.innerHTML = rest.length > 0
            ? rest.map((item, i) => buildCardHTML(item, i)).join('')
            : '';
    }
}

/*
 * renderArticlePage()
 * Called by article.html. Reads ?id= from the URL,
 * finds the matching item, and renders the full article.
 * Expects #contentSkeleton and #articleBody in the DOM.
 */
async function renderArticlePage() {
    const id         = urlParam('id');
    const skeletonEl = document.getElementById('contentSkeleton');
    const bodyEl     = document.getElementById('articleBody');

    const all  = await fetchContent();
    const item = id ? all.find(i => i.id === parseInt(id, 10)) || null : null;

    if (skeletonEl) skeletonEl.style.display = 'none';

    if (!item) {
        if (bodyEl) bodyEl.innerHTML = `
            <p class="article-error">
                Article not found. <a href="index.html">← Return to Latest</a>
            </p>`;
        return;
    }

    // Update the browser tab title
    document.title = `${item.title} — Mainspring News`;

    const img   = item.image && item.image.trim() ? item.image : null;
    const badge = item.type === 'review' ? 'Review' : 'Article';

    if (bodyEl) bodyEl.innerHTML = `
        <header class="article-header">
            ${img ? `
            <div class="article-hero-img">
                <img src="${esc(img)}" alt="${esc(item.title)}"
                     onerror="this.parentNode.style.display='none'">
            </div>` : ''}
            <span class="article-type-badge">${badge}</span>
            <h1 class="article-title">${esc(item.title)}</h1>
            <div class="article-byline">
                <span>${esc(item.author || 'Mainspring News')}</span>
                <span class="byline-sep">·</span>
                <span>${fmtDate(item.date)}</span>
                ${item.readTime ? `<span class="byline-sep">·</span>
                <span>${esc(item.readTime)}</span>` : ''}
            </div>
        </header>
        <div class="article-prose">
            ${item.body || '<p>Content coming soon.</p>'}
        </div>
        ${item.tags && item.tags.length ? `
        <div class="article-tags">
            ${item.tags.map(t => `<span class="article-tag">${esc(t)}</span>`).join('')}
        </div>` : ''}`;
}

/*
 * getOriginalArticlesAsRSSItems()
 * Called by news.html to prepend original content to the RSS feed.
 * Returns items shaped to match the allArticles array in news.html.
 */
async function getOriginalArticlesAsRSSItems() {
    const all = await fetchContent();
    return all.map(item => ({
        title:     item.title  || '',
        link:      `article.html?id=${item.id}`,
        image:     item.image  || null,
        summary:   item.excerpt || '',
        readTime:  item.readTime || '5 min read',
        source:    'Mainspring',
        date:      item.date   || '',
        timestamp: new Date(item.date || 0).getTime(),
        _original: true   // flag so the news page can style these differently
    }));
}
