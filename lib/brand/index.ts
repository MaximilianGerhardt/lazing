/**
 * Brand constants for the lazyOS → laz.ing migration.
 *
 * ENV override `LAZYOS_BRAND_NAME` allows rollback without code change:
 *   LAZYOS_BRAND_NAME=lazyOS  → old brand
 *   LAZYOS_BRAND_NAME=laz.ing → new brand (default)
 *
 * IMPORTANT: use ONLY for the user-facing wordmark. NOT for DB IDs,
 * cookie keys, ENV var names, systemd unit names, code identifiers
 * (LazyDb, LAZYOS_*) — those stay "lazyos"-prefixed.
 */
export const BRAND_NAME = process.env.LAZYOS_BRAND_NAME?.trim() || 'laz.ing';
export const BRAND_LEGAL = 'Example Company';
export const BRAND_DOMAIN = 'laz.ing';
export const BRAND_PRIMARY_URL = 'https://app.laz.ing';
export const BRAND_TWO_FA_ISSUER = BRAND_NAME;
export const BRAND_EMAIL_FROM_DEFAULT = `${BRAND_NAME} <noreply@mail.example.com>`;
