// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// Reserved-Identifier for ADR-0004 V1-Single-User-Stub.
// String MUST NOT appear literally outside this file (enforced by lint rule).

export const OWNER_DEFAULT_WORKSPACE_ID = 'owner-default' as const;

export function defaultWorkspaceFor(userUlid: string): string {
  if (process.env.LAZYOS_MULTI_TENANT === '1') {
    return `user-default:${userUlid}`;
  }
  return OWNER_DEFAULT_WORKSPACE_ID;
}
