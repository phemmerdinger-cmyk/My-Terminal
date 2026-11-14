# $0 cost audit (News reader, research spider, signals, event study — Nov 2026)

Every new piece added in this release, what it costs and why it can't bill you.

| Component | Kind | Cost | Card needed? | Can it bill unexpectedly? | Notes |
|---|---|---|---|---|---|
| Federal Reserve press RSS | Data (public domain) | $0 | No | No | Board website policy: public domain, copy with credit. Full text shown in the reader. |
| SEC press RSS + EDGAR submissions / filings | Data (public record) | $0 | No | No | Fair access: ≤10 requests/s with a declared User-Agent; the server spaces SEC calls 250 ms apart and caches them. |
| BLS RSS | Data (public domain) | $0 | No | No | BLS: public domain, cite BLS. |
| BEA RSS | Data (public domain) | $0 | No | No | U.S. government work (17 U.S.C. §105). |
| Treasury press-release page | Data (public domain) | $0 | No | No | Read once per 30 min, cached. |
| Publisher feeds (Yahoo, CNBC, Morningstar, Seeking Alpha, WSJ via Google News) | Data | $0 | No | No | Headlines, the feed's own summary and the page's own meta description only, with a link back. No full text, no paywall bypass. |
| Yahoo Finance daily prices (`/api/pub/hist`) | Data | $0 | No | No | Already used; event study reuses the shared cache. |
| `public/reader.js`, `reader.css`, `web-control.js` | Code (own) | $0 | — | No | No third-party libraries; plain JS/SVG. |
| Rules-based NLP (extractive key points, keyword bull/bear factors, entity grouping, signal rules) | Code (own) | $0 | — | No | No AI inference API is called by any of these features. |
| Upstash Redis (already configured if the keys are set) | Storage | $0 | No (free tier) | No | Free tier: 256 MB, 500K commands/month; a free database is only upgraded if you add a card. The spider saves at most once a minute. |
| Browser localStorage | Storage | $0 | — | No | Saved articles, reader settings, price-history cache. |
| Render free web service | Hosting | $0 | No | No | 750 free instance hours/month; sleeps after 15 min idle; ephemeral disk. If free hours run out Render suspends the service, it doesn't bill. Watch the Hobby bandwidth allowance; reader responses are small JSON. |
| GitHub Actions (tests + keep-warm ping) | Scheduling/CI | $0 | No | No | Public repository: standard runners are free and unlimited. |

**Expected additional recurring cost: $0.00 per month.**

Not changed by this release: the Claude API features you turned on earlier (Predictor, Ask Claude) still use your Anthropic key behind the password and the $4 / $1-a-day budget. None of the new features call it, and the spider's `ask` only uses Claude if you explicitly request it.

Limits stated honestly:
- Full article text is shown only for public-domain / public-record sources. Commercial publishers get their own summary plus a labelled Market Desk briefing and a link.
- Research runs while the Render service is awake (the keep-warm ping covers about 7 AM–11 PM Eastern). It is not 24/7; the spider catches up on its schedule after a wake-up.
- Without Upstash keys, research memory lives in the temp folder and is lost on redeploy; use THE WEB › Control center › Download research memory, then restore.
