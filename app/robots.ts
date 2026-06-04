/**
 * robots.txt — Privacy-Sprint H3 (2026-05-01).
 *
 * lazyOS hostet potenziell sensible interne Daten (Audits, Workstreams,
 * Org-Strukturen, API-Routes). Bei Public-Domain-Deploy oder OSS-Launch
 * dürfen diese Pfade NICHT in Suchmaschinen-Indizes landen.
 *
 * Defense-in-Depth zusätzlich zu Auth:
 *   1. Auth-Gate (Middleware) blockt unauth-Requests bereits.
 *   2. robots.txt verhindert dass Bots überhaupt crawlen versuchen.
 *   3. <meta name="robots" content="noindex,nofollow"> im Root-Layout
 *      stellt sicher dass auch User-Agent-Bypasses oder Cache-Snapshots
 *      nicht indexiert werden.
 */
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: [
          "/reasoning-audit/",
          "/observatory/",
          "/workstreams/",
          "/api/",
          "/orgs/",
          "/workspaces/",
          "/inbox/",
          "/tickets/",
          "/skills/",
        ],
      },
    ],
  };
}
