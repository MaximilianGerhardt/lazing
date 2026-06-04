# Cloudron — laz.ing app manifest

## Provider

Cloudron is a self-host platform — apps are packaged as a Docker image plus a
`CloudronManifest.json`. It has an engaged self-host community.

→ Docs: https://docs.cloudron.io/packaging/

## Submission requirements

1. **`CloudronManifest.json`** in the repo root:
   ```json
   {
     "id": "io.lazyos.cloudronapp",
     "title": "laz.ing",
     "author": "Maximilian Gerhardt",
     "description": "file://DESCRIPTION.md",
     "tagline": "Local-first AI agent runtime with mid-course correction.",
     "version": "0.1.0",
     "healthCheckPath": "/api/health",
     "httpPort": 4200,
     "memoryLimit": 1073741824,
     "addons": {
       "localstorage": {}
     },
     "manifestVersion": 2,
     "website": "https://github.com/MaximilianGerhardt/lazing",
     "contactEmail": "contact@laz.ing",
     "icon": "file://icons/512.png",
     "tags": ["ai", "agents", "self-host", "developer-tools"],
     "minBoxVersion": "7.0.0"
   }
   ```
   <!-- TODO(owner): set a real contactEmail before submitting. -->
2. **`DESCRIPTION.md`** — short description (50-200 words).
3. **`CHANGELOG.md`** — versioned per release.
4. **Icons** in the `icons/` folder (256/512 PNG).
5. **Cloudron build**: laz.ing must respect the `CLOUDRON_*` env vars (see the
   Cloudron docs). `LAZYOS_DB_PATH` must point at `/app/data/` (the Cloudron
   standard for the localstorage addon).

## Open question — auth integration

Cloudron apps usually need explicit `CLOUDRON_AUTH_*` integration for
single-sign-on. laz.ing has its own auth system (magic link). Options:

A) Build a Cloudron OIDC integration (a dedicated SSO effort).
B) Bypass Cloudron auth and keep laz.ing auth — fine for a solo user, but the
   Cloudron multi-user mapping is missing.

→ **Recommendation for a first pass**: ship Cloudron with laz.ing's own auth,
without SSO. Users understand it is a standalone app.

## Open tasks

- [ ] Write CloudronManifest.json and validate locally with the cloudron CLI
- [ ] DESCRIPTION.md (200 words)
- [ ] Create the icons folder
- [ ] LAZYOS_DB_PATH default via env detection (CLOUDRON_APP_BASE_DIR)
- [ ] Set up a local Cloudron sandbox for testing
