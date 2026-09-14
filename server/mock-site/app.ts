import express from "express";

/**
 * A tiny local "target website" with a known set of deliberate issues.
 * Used as a test fixture / demo target so the analyzer can be exercised
 * end-to-end without needing outbound internet access (this sandbox's
 * network egress is restricted to package registries, not arbitrary
 * websites).
 *
 * /messy       -> many issues (used to verify detection + scoring)
 * /clean       -> a well-optimized page (used to verify low false-positive rate)
 * /redirect-me -> redirects to /clean (used to verify redirect detection)
 * /slow        -> artificially delayed response (used to verify TTFB detection)
 */

const PORT = Number(process.env.MOCK_PORT ?? 4100);

const bigInlinePadding = "<!-- padding ".repeat(6000) + "-->";

const messyHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <script src="/vendor1.js"></script>
  <script src="/vendor2.js"></script>
  <script src="/vendor3.js"></script>
  <link rel="stylesheet" href="/a.css">
  <link rel="stylesheet" href="/b.css">
  <link rel="stylesheet" href="/c.css">
  <link rel="stylesheet" href="/d.css">
  <link rel="stylesheet" href="/e.css">
</head>
<body>
  <h1>Welcome</h1>
  <h1>Second heading also H1</h1>
  <img src="/hero.png">
  <img src="/logo.png" alt="">
  <img src="http://insecure.example.com/tracker.png">
  <p>Some content on the messy test page.</p>
  ${bigInlinePadding}
</body>
</html>`;

const cleanHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clean Demo Page - A Well Optimized Example</title>
  <meta name="description" content="This is a clean, well-optimized demo page used to verify the analyzer does not produce false positives on healthy sites.">
  <link rel="canonical" href="http://localhost:${PORT}/clean">
  <script src="/app.js" defer></script>
  <link rel="stylesheet" href="/main.css">
</head>
<body>
  <h1>Clean Demo Page</h1>
  <img src="/hero.png" alt="Descriptive hero image">
  <p>This page is intentionally well-optimized.</p>
</body>
</html>`;

/**
 * A tiny linked "site" under /site/*, used by the crawler tests
 * (crawler.test.ts / sitePipeline.test.ts). Deliberately includes:
 * - a back-link (home <-> about) to exercise dedup
 * - a trailing-slash duplicate of the home URL (same dedup mechanism)
 * - mailto:/tel:/javascript:/fragment-only/external links, all of
 *   which must never become crawl candidates
 * - a linear depth chain (deep/level2 -> level3 -> level4) to exercise
 *   maxDepth
 * - a page that returns non-HTML content (broken) to exercise
 *   per-page error isolation
 * - a page disallowed via robots.txt (disallowed)
 * - a page reachable ONLY via sitemap.xml, not linked from anywhere
 *   (only-in-sitemap), to exercise sitemap-based discovery
 */
function sitePage(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${bodyHtml}</body>
</html>`;
}

const siteHomeHtml = sitePage(
  "Site Home",
  `
  <a href="/site/about">About</a>
  <a href="/site/contact">Contact</a>
  <a href="/site/broken">Broken</a>
  <a href="/site/deep/level2">Deep</a>
  <a href="/site/disallowed">Disallowed</a>
  <a href="/site/home/">Home (trailing slash duplicate)</a>
  <a href="https://external-example.test/page">External</a>
  <a href="mailto:test@example.com">Mail</a>
  <a href="tel:+15551234567">Call</a>
  <a href="javascript:void(0)">JS link</a>
  <a href="#section">Fragment only</a>
  `,
);
const siteAboutHtml = sitePage("Site About", `<a href="/site/home">Back to Home</a>`);
const siteContactHtml = sitePage("Site Contact", `<p>No outbound links here - a dead end on purpose.</p>`);
const siteDeepLevel2Html = sitePage("Deep Level 2", `<a href="/site/deep/level3">Level 3</a>`);
const siteDeepLevel3Html = sitePage("Deep Level 3", `<a href="/site/deep/level4">Level 4</a>`);
const siteDeepLevel4Html = sitePage("Deep Level 4", `<p>Leaf page - no further links.</p>`);
const siteDisallowedHtml = sitePage("Site Disallowed", `<p>Should never be analyzed when robots.txt is respected.</p>`);
const siteOnlyInSitemapHtml = sitePage("Only In Sitemap", `<p>Reachable only via sitemap.xml, not linked from any crawled page.</p>`);

export function createMockApp() {
  const app = express();

  app.get("/messy", (_req, res) => {
    res
      .status(200)
      // deliberately: no compression, no cache-control, no security headers
      .type("html")
      .send(messyHtml);
  });

  app.get("/clean", (_req, res) => {
    res
      .status(200)
      .set({
        "Cache-Control": "public, max-age=3600",
        "Content-Encoding": "identity",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": "default-src 'self'",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      })
      .type("html")
      .send(cleanHtml);
  });

  app.get("/redirect-me", (_req, res) => {
    res.redirect(302, "/clean");
  });

  app.get("/slow", async (_req, res) => {
    await new Promise((r) => setTimeout(r, 2000));
    res.type("html").send(cleanHtml);
  });

  // --- crawler test fixtures (see the doc comment above siteHomeHtml) ---
  app.get("/site/home", (_req, res) => res.type("html").send(siteHomeHtml));
  app.get("/site/about", (_req, res) => res.type("html").send(siteAboutHtml));
  app.get("/site/contact", (_req, res) => res.type("html").send(siteContactHtml));
  app.get("/site/broken", (_req, res) => res.status(200).type("json").send(JSON.stringify({ not: "html" })));
  app.get("/site/deep/level2", (_req, res) => res.type("html").send(siteDeepLevel2Html));
  app.get("/site/deep/level3", (_req, res) => res.type("html").send(siteDeepLevel3Html));
  app.get("/site/deep/level4", (_req, res) => res.type("html").send(siteDeepLevel4Html));
  app.get("/site/disallowed", (_req, res) => res.type("html").send(siteDisallowedHtml));
  app.get("/site/only-in-sitemap", (_req, res) => res.type("html").send(siteOnlyInSitemapHtml));
  app.get("/robots.txt", (req, res) => {
    // Built from the actual request host, NOT the module-level PORT
    // constant - tests bind the mock server to an OS-assigned random
    // port via listen(0), which almost never matches PORT/MOCK_PORT.
    const origin = `${req.protocol}://${req.get("host")}`;
    res.type("text/plain").send(`User-agent: *\nDisallow: /site/disallowed\nSitemap: ${origin}/sitemap.xml\n`);
  });
  app.get("/sitemap.xml", (req, res) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    res.type("application/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${origin}/site/home</loc></url>\n  <url><loc>${origin}/site/only-in-sitemap</loc></url>\n</urlset>`,
    );
  });

  return app;
}

export default createMockApp();
