/**
 * robots.txt — Privacy-Sprint H3 (2026-05-01).
 *
 * lazyOS hosts potentially sensitive internal data (audits, workstreams,
 * org structures, API routes). On public-domain deploy or OSS launch
 * these paths must NOT land in search-engine indexes.
 *
 * Defense-in-depth in addition to auth:
 *   1. The auth gate (middleware) already blocks unauth requests.
 *   2. robots.txt prevents bots from even attempting to crawl.
 *   3. <meta name="robots" content="noindex,nofollow"> in the root layout
 *      ensures that even user-agent bypasses or cache snapshots
 *      are not indexed.
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
