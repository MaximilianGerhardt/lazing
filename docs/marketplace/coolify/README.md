# Coolify — laz.ing service template

Coolify is an open-source Heroku alternative. Setup is trivial because our
docker-compose.yml is usable directly.

## One-click deploy

1. In the Coolify UI, the user clicks "New Resource → From Git Repository".
2. Repo URL: `https://github.com/<your-fork>/lazing.git`
3. Coolify detects `docker-compose.yml` automatically.
4. ENV vars are entered in the Coolify UI.
5. Deploy.

## Service template (for the Coolify marketplace)

Coolify has an official service-templates repo:
https://github.com/coollabsio/coolify/tree/main/templates/compose

A PR submission to that repo with:
- `lazyos.yaml` (the compose content)
- `lazyos.md` (description + setup guide)
- Logo (256×256 SVG)

## Submission workflow

1. Fork `coollabsio/coolify`.
2. `templates/compose/lazyos.yaml` with our docker-compose.yml content +
   Coolify annotations.
3. PR with a description ("multi-agent OS for Claude...").
4. Maintainer review (~1–2 weeks).

## Template stub

```yaml
# templates/compose/lazyos.yaml
documentation: https://github.com/<your-fork>/lazing/blob/main/README.md
slogan: Multi-agent OS for Claude with mid-flight sniper correction
tags:
  - ai
  - claude
  - agents
  - self-host
logo: svgs/lazyos.svg
minimum_version: 4.0.0

# Compose content: include via file://docker-compose.yml
```

## Open tasks

- [ ] Test the Coolify compose template locally with a Coolify sandbox
- [ ] PR to coollabsio/coolify
- [ ] Provide the SVG logo at the Coolify-specific path
