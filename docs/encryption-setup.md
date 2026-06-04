# Encryption setup

## TL;DR

Workspaces marked `sensitivity='high'` are only writable once a master
key-encryption-key is configured. Set `LAZYOS_MASTER_KEK` in the environment.

## Generate the master KEK

```bash
openssl rand -hex 32
```

→ produces 64 hex chars (= 32 bytes / 256 bits). Set this value as
`LAZYOS_MASTER_KEK` in the environment — locally in `.env.local`, on a VPS via
the systemd service definition, on a PaaS as an encrypted env variable.

## How it works

```
LAZYOS_MASTER_KEK (env, 32 bytes)
    │
    │  AES-256-GCM wrap
    ▼
workspace_keys.wrapped_dek (DB, 60 bytes base64url)
    │
    │  unwrap on demand, in-memory cache
    ▼
DEK (32 bytes, in process memory)
    │
    │  AES-256-GCM
    ▼
cloud_artifacts on disk:
  [12 bytes nonce][16 bytes auth tag][N bytes ciphertext]
```

- **Master KEK**: one per installation, lives only in the environment.
- **Per-workspace DEK**: randomly generated on the first write to the workspace,
  wrapped with the master KEK, stored in `workspace_keys`.
- **Per file**: random 96-bit nonce, 128-bit auth tag (AES-GCM standard). Never
  the same nonce twice per DEK (cryptographic invariant).

## What happens if the KEK is lost

**Data loss** for all encrypted files. No recovery. Keep the KEK in:
- Encrypted backup storage (e.g. a password manager / secret manager)
- An encrypted env variable on your hosting provider
- A systemd drop-in with `EnvironmentFile=` pointing at a chmod-600 file on a VPS

**Never** in git, never in logs, never as a default in code.

## KEK rotation

- Unwrap all existing DEKs (old KEK)
- Re-wrap with the new KEK
- Increment `key_version`
- The old KEK can then be deleted

## Without a KEK

- `isEncryptionAvailable()` returns `false`
- Sensitive workspaces remain **read-only** (the sensitivity floor blocks writes)
- Non-sensitive workspaces (low/normal/medium) keep working without encryption
  (`encryption_version=0` in the DB row)

## Live verification

```bash
# 1. set the KEK
export LAZYOS_MASTER_KEK=$(openssl rand -hex 32)

# 2. restart the server so the env takes effect (or systemd reload)

# 3. try an upload into a high-sensitivity workspace via /api/cloud

# 4. inspect on disk — should be random bytes
xxd ~/.lazyos/cloud/<workspace>/ART-XXX | head -5

# 5. download → must come back correctly decrypted
```
