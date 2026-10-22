/* ═══════════════════════════════════════════════════
   Mainspring News — Active Nav Highlighting
   Loaded directly after <nav class="site-nav"> on every page.
   Matches window.location.pathname to a .nav-link href and adds
   .active (gold text + underline, styled in site.css).
   ═══════════════════════════════════════════════════ */
(function () {
    // Normalise "/", "/index.html", "/opinion", "/opinion.html" → "opinion"
    function pageKey(path) {
        var name = (path || '').split('/').pop().replace(/\.html$/i, '');
        return (name === '' || name === 'index') ? 'opinion' : name;
    }

    // article.html belongs to whichever section the reader came from
    var current = pageKey(window.location.pathname);
    if (current === 'article') {
        var from = '';
        try { from = pageKey(new URL(document.referrer).pathname); } catch (e) {}
        current = (from === 'reviews' || from === 'news') ? from : 'opinion';
    }

    document.querySelectorAll('.site-nav .nav-link').forEach(function (link) {
        var isActive = pageKey(link.getAttribute('href')) === current;
        link.classList.toggle('active', isActive);
        if (isActive) link.setAttribute('aria-current', 'page');
    });
}());
