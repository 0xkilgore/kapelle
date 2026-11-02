# Newsletter renderer v3: lifted sources (Package E; Fable e9cdd63c N-2)

Source repo: `0xkilgore/example-org-website` (Alex-owned, private; direct lift permitted by the owner), read at `origin/main` **f3048fd94ae0ade8d2707affa9d523e608dec624**.

| Lifted file | sha256 at f3048fd | Into | What was kept / changed |
|---|---|---|---|
| `src/lib/newsletter-template.tsx` (wrapEmailTemplate, renderHeaderHtml) | 0ef11eec6935add81fdbd03ecfb5c0cf9d559d32591407be9593783894d3d124 | `render-cp.ts` | **Kept:** the 640 px table shell, the header structure (wordmark, nav, rule, month line, 4-photo strip from `/newsletter/photos/`), the body typography and the footer (reply line, Unsubscribe, View on web, org line). **Changed:** styles inlined in code (no `juice`); the Google Fonts `@import` dropped; colours and fonts from the site's current theme (row below); the lockup from `src/components/Header.tsx`. |
| `src/lib/newsletter-image-preflight.ts` | f29083c0b0d3eb04a9ab10c8dca9a403abbcb981895b81303a80d653e7289573 | `image-preflight.ts` | **Kept:** HEAD, then a 1-byte ranged GET on 403/405; 10 s timeout; https only; `image/*`. **Changed:** the E-1 allowlist runs before any network call; redirects are not followed; a bounded (≤ 5 MiB) content GET hashes the bytes into the release package; fixed labels. |
| `src/app/globals.css` `@theme` (commit 9defe42 "Rebrand site as Example Park with FoCP logo palette") | 882b1434fbbb47e3aa986412cc62c42cfa7dbb68337e28e8960861c980456a22 | `CP_THEME` in `render-cp.ts` | Tokens only (primary, primary-dark, primary-light, accent, surface, foreground, muted, border); fonts per `src/app/layout.tsx` (Fraunces, Plus Jakarta Sans). |

Runbook note (Fable N-1): the header strip and the emblem are fixed template URLs on the site. If the site replaces those files, the content hash refuses the next test with `newsletter_image_changed`. Read that as "the site was updated, prepare again", not as tampering.
