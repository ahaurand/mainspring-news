/* ═══════════════════════════════════════════════════
   Mainspring News — RSS Proxy (Vercel Serverless Function)
   GET /api/rss?url=<encoded feed URL>[&category=<name>]

   Fetches an allow-listed RSS/Atom feed server-side (no CORS
   issues, no third-party proxy) and returns JSON in the same
   shape as api.rss2json.com, so news.html can use either:

     { status: 'ok', feed: { title }, items: [
         { title, link, pubDate, description, content,
           thumbnail, enclosure: { link }, categories: [] } ] }
   ═══════════════════════════════════════════════════ */

// Only these hosts may be proxied — keeps this from being an open proxy.
const ALLOWED_HOSTS = new Set([
    'www.hodinkee.com',
    'wornandwound.com',
    'www.fratellowatches.com',
    'monochrome-watches.com',
    'www.ablogtowatch.com',
    'teddybaldassarre.com',
    'twobrokewatchsnobs.com',
    'oracleoftime.com',
    'timeandtidewatches.com',
    'www.watchtime.com',
    'revolutionwatch.com',
    'quillandpad.com',
    'www.watchprosite.com',
    'www.gearpatrol.com',
    'www.wristenthusiast.com',
    'www.watches-news.com'
]);

const UPSTREAM_TIMEOUT_MS = 9000;
const MAX_ITEMS = 30;

// ══════════════════════════════════
//  Minimal XML helpers (no dependencies)
// ══════════════════════════════════
function decodeEntities(str) {
    return str
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

// Inner text of a tag; CDATA is returned verbatim, plain text is entity-decoded
function unwrap(raw) {
    if (raw == null) return '';
    const s = raw.trim();
    const cdata = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    return cdata ? cdata[1].trim() : decodeEntities(s);
}

function tag(xml, name) {
    const esc = name.replace(':', '\\:');
    const m = xml.match(new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`, 'i'));
    return m ? unwrap(m[1]) : '';
}

function tagAll(xml, name) {
    const esc = name.replace(':', '\\:');
    const re = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`, 'gi');
    return [...xml.matchAll(re)].map(m => unwrap(m[1])).filter(Boolean);
}

function attr(xml, tagName, attrName, filter) {
    const esc = tagName.replace(':', '\\:');
    const re = new RegExp(`<${esc}\\s[^>]*>`, 'gi');
    for (const m of xml.matchAll(re)) {
        if (filter && !filter(m[0])) continue;
        const a = m[0].match(new RegExp(`${attrName}=["']([^"']+)["']`, 'i'));
        if (a) return decodeEntities(a[1]);
    }
    return '';
}

// Plain text for titles: decode entities left inside CDATA and drop stray tags
function text(str) {
    return decodeEntities(str.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// ══════════════════════════════════
//  Feed → rss2json-shaped items
// ══════════════════════════════════
function parseFeed(xml, category) {
    const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
    const blocks = isAtom
        ? [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map(m => m[0])
        : [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(m => m[0]);

    let items = blocks.map(b => {
        const link = isAtom
            ? (attr(b, 'link', 'href', t => !/rel=["'](?!alternate)/i.test(t)) || attr(b, 'link', 'href'))
            : tag(b, 'link') || tag(b, 'guid');

        const description = isAtom ? tag(b, 'summary') || tag(b, 'content') : tag(b, 'description');
        const content     = isAtom ? tag(b, 'content') : tag(b, 'content:encoded');

        const thumbnail =
            attr(b, 'media:thumbnail', 'url') ||
            attr(b, 'media:content', 'url', t => !/medium=["'](?!image)/i.test(t)) ||
            '';
        const enclosureLink = attr(b, 'enclosure', 'url', t => /type=["']image/i.test(t) || !/type=/i.test(t));

        return {
            title:       text(tag(b, 'title')),
            link:        link.trim(),
            pubDate:     tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'),
            description,
            content,
            thumbnail,
            enclosure:   enclosureLink ? { link: enclosureLink } : {},
            categories:  tagAll(b, 'category').concat(
                             [...b.matchAll(/<category\s[^>]*term=["']([^"']+)["']/gi)].map(m => decodeEntities(m[1])))
        };
    });

    if (category) {
        const want = category.toLowerCase();
        items = items.filter(i => i.categories.some(c => c.toLowerCase() === want));
    }

    const head = xml.split(/<item[\s>]|<entry[\s>]/i)[0];
    return { title: text(tag(head, 'title')), items: items.slice(0, MAX_ITEMS) };
}

// ══════════════════════════════════
//  Handler
// ══════════════════════════════════
module.exports = async function handler(req, res) {
    const feedUrl  = (req.query && req.query.url) || '';
    const category = (req.query && req.query.category) || '';

    let parsed;
    try { parsed = new URL(feedUrl); } catch (e) { parsed = null; }

    if (!parsed || parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
        res.status(400).json({ status: 'error', message: 'Feed URL missing or not allow-listed' });
        return;
    }

    try {
        const upstream = await fetch(parsed.href, {
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            redirect: 'follow',
            headers: {
                // Several publishers 403 obvious bot user-agents, so present as a browser
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5'
            }
        });

        if (!upstream.ok) {
            res.status(502).json({ status: 'error', message: `Upstream HTTP ${upstream.status}` });
            return;
        }

        const xml = await upstream.text();
        if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) {
            res.status(502).json({ status: 'error', message: 'Upstream did not return RSS/Atom (likely a bot challenge)' });
            return;
        }

        const { title, items } = parseFeed(xml, category);

        // Cache at Vercel's edge for 15 min, serve stale for up to an hour while revalidating
        res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
        res.status(200).json({ status: 'ok', feed: { title, url: parsed.href }, items });
    } catch (e) {
        res.status(504).json({ status: 'error', message: e.name === 'TimeoutError' ? 'Upstream timed out' : e.message });
    }
};
