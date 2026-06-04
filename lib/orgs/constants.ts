/**
 * Phase AU.2.3 — default IDs for org and workspace.
 *
 * Single source for constants. Used both by the setup script and by
 * first-boot detection and a few UI paths.
 *
 * ENV override allowed: operators can set their own default IDs at setup
 * (e.g. "acme-internal" instead of "workspace").
 */

export const DEFAULT_ORG_ID =
  process.env.LAZYOS_DEFAULT_ORG_ID?.trim() || "workspace";

export const DEFAULT_ORG_NAME =
  process.env.LAZYOS_DEFAULT_ORG_NAME?.trim() || "My Workspace";

export const DEFAULT_WORKSPACE_ID =
  process.env.LAZYOS_DEFAULT_WORKSPACE_ID?.trim() || "default";

export const DEFAULT_WORKSPACE_LABEL =
  process.env.LAZYOS_DEFAULT_WORKSPACE_LABEL?.trim() || "Workspace";
