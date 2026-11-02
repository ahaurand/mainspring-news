/* ═══════════════════════════════════════════════════
   Mainspring News — YouTube Channel Feed (Vercel Serverless Function)
   GET /api/youtube?channel=<UC… channel ID>

   Reads a channel's public YouTube RSS feeds server-side and returns
   its latest Videos and Shorts, newest first:

     { status: 'ok', channel: { id, title }, items: [
         { videoId, title, link, published, description,
           isShort, duration } ] }

   Content filter — uses YouTube's per-channel upload playlists:
     UULF… = long-form uploads only, UUSH… = Shorts only.
   Live streams, community posts and playlists never appear in
   either; videos titled as podcast episodes are dropped.

   Duration — YouTube RSS has no runtime field, so:
     • If the YOUTUBE_API_KEY env var is set, exact durations come
       from the YouTube Data API (videos.list, 1 quota unit/call).
     • Otherwise they're read from the runtime badges on the
       channel's /videos page. Shorts have no badge → duration ''.
   ═══════════════════════════════════════════════════ */

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_ITEMS = 30;
const PODCAST_RE = /\bpodcast\b/i;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    // Skip the EU cookie-consent interstitial on youtube.com pages
    'Cookie': 'SOCS=CAI'
};

// ══════════════════════════════════
//  Helpers
// ══════════════════════════════════
function decodeEntities(str) {
    return (str || '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

// Resolves to { ok, status, text } — never throws
async function getText(url) {
    try {
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
        return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' };
    } catch (e) {
        return { ok: false, status: e.name === 'TimeoutError' ? 'timeout' : e.message, text: '' };
    }
}

function feedUrl(param) {
    return `https://www.youtube.com/feeds/videos.xml?${param}`;
}

// YouTube Atom feed → entries
function parseYouTubeFeed(xml, forceShort) {
    const pick = (b, re) => { const m = b.match(re); return m ? decodeEntities(m[1]).trim() : ''; };
    // Upload-playlist feeds are titled generically ("Videos"), so use the channel's author name
    const head  = xml.split('<entry>')[0];
    const title = pick(head, /<author>\s*<name>([\s\S]*?)<\/name>/) || pick(head, /<title>([\s\S]*?)<\/title>/);

    const items = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map(m => {
        const b = m[0];
        const link = pick(b, /<link rel="alternate" href="([^"]+)"/);
        return {
            videoId:     pick(b, /<yt:videoId>([^<]+)<\/yt:videoId>/),
            title:       pick(b, /<title>([\s\S]*?)<\/title>/),
            link,
            published:   pick(b, /<published>([^<]+)<\/published>/),
            description: pick(b, /<media:description>([\s\S]*?)<\/media:description>/).slice(0, 400),
            isShort:     forceShort === undefined ? link.includes('/shorts/') : forceShort,
            duration:    ''
        };
    }).filter(i => i.videoId);

    return { title, items };
}

// Runtime badges on the channel /videos page: "text":"28:21" … "animationActivationTargetId":"<videoId>"
function scrapeDurations(html) {
    const map = {};
    const badge = /"thumbnailBadgeViewModel":\{"text":"(\d{1,2}(?::\d{2}){1,2})"[^{}]*?"animationActivationTargetId":"([\w-]{11})"/g;
    for (const m of html.matchAll(badge)) map[m[2]] = m[1];
    // Older page layout (videoRenderer)
    const legacy = /"videoId":"([\w-]{11})"[\s\S]{0,4000}?"lengthText":\{[^}]*?"simpleText":"(\d{1,2}(?::\d{2}){1,2})"/g;
    for (const m of html.matchAll(legacy)) if (!map[m[1]]) map[m[1]] = m[2];
    return map;
}

// ISO 8601 (PT1H2M3S) → "1:02:03" / "2:03"
function isoToClock(iso) {
    const m = (iso || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return '';
    const h = Number(m[1] || 0) * 24 + Number(m[2] || 0), min = Number(m[3] || 0), s = Number(m[4] || 0);
    if (!h && !min && !s) return '';
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

async function apiDurations(ids, key) {
    const map = {};
    for (let i = 0; i < ids.length; i += 50) {
        const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids.slice(i, i + 50).join(',')}&key=${encodeURIComponent(key)}`;
        const res = await getText(url);
        if (!res.ok) throw new Error(`YouTube Data API HTTP ${res.status}`);
        for (const v of JSON.parse(res.text).items || []) map[v.id] = isoToClock(v.contentDetails && v.contentDetails.duration);
    }
    return map;
}

// ══════════════════════════════════
//  Handler
// ══════════════════════════════════
module.exports = async function handler(req, res) {
    const channelId = (req.query && req.query.channel) || '';
    if (!CHANNEL_ID_RE.test(channelId)) {
        res.status(400).json({ status: 'error', message: 'Missing or invalid channel ID' });
        return;
    }

    const suffix = channelId.slice(2);
    const apiKey = process.env.YOUTUBE_API_KEY;

    const [longForm, shorts, videosPage] = await Promise.all([
        getText(feedUrl(`playlist_id=UULF${suffix}`)),
        getText(feedUrl(`playlist_id=UUSH${suffix}`)),
        apiKey ? Promise.resolve(null) : getText(`https://www.youtube.com/channel/${channelId}/videos`)
    ]);

    let title = '';
    let items = [];

    // The upload playlists 404 when a channel has none of that type, so one
    // success is enough. If both fail, fall back to the all-uploads feed.
    if (longForm.ok || shorts.ok) {
        const a = longForm.ok ? parseYouTubeFeed(longForm.text, false) : { title: '', items: [] };
        const b = shorts.ok   ? parseYouTubeFeed(shorts.text, true)    : { title: '', items: [] };
        title = a.title || b.title;
        items = a.items.concat(b.items);
    } else {
        const all = await getText(feedUrl(`channel_id=${channelId}`));
        if (!all.ok) {
            res.status(502).json({ status: 'error', message: `YouTube feed HTTP ${all.status}` });
            return;
        }
        ({ title, items } = parseYouTubeFeed(all.text));
    }

    items = items
        .filter(i => !PODCAST_RE.test(i.title))
        .sort((a, b) => new Date(b.published) - new Date(a.published))
        .slice(0, MAX_ITEMS);

    // Durations (best effort — a failure here never fails the request)
    try {
        const map = apiKey
            ? await apiDurations(items.map(i => i.videoId), apiKey)
            : (videosPage && videosPage.ok ? scrapeDurations(videosPage.text) : {});
        items.forEach(i => { i.duration = map[i.videoId] || ''; });
    } catch (e) {
        console.warn(`[youtube] durations unavailable for ${channelId}: ${e.message}`);
    }

    // Cache at Vercel's edge for 30 min, serve stale for up to 2 hours while revalidating
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=7200');
    res.status(200).json({ status: 'ok', channel: { id: channelId, title }, items });
};
