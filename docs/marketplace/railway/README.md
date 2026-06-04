# Railway — laz.ing template

Railway has a template marketplace with one-click deploy buttons.

→ Docs: https://railway.app/templates

## Submission

1. Create a Railway account (free).
2. Create your own project in Railway, linked to the laz.ing repo.
3. Project settings → "Make Template" → Public.
4. Fill in the template metadata (name, description, env-var defaults).
5. The submission is auto-approved (Railway has no manual review for templates).

## Template config

```toml
# railway.json (in the repo root)
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "./Dockerfile"
  },
  "deploy": {
    "startCommand": "/docker-entry.sh",
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 60,
    "restartPolicyType": "ON_FAILURE"
  }
}
```

## Volume note

Railway has persistent volumes on paid plans. On the free tier, storage is
ephemeral — similar to DigitalOcean App Platform.

User hint in the template: "For production, enable a persistent volume or use a
Hobby+/Pro plan."

## Open tasks

- [ ] Commit railway.json to the repo
- [ ] Template page description
- [ ] Add a "Deploy on Railway" button to the README:
  ```markdown
  [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/<id>)
  ```
