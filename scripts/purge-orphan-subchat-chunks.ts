#!/usr/bin/env tsx
/**
 * purge-orphan-subchat-chunks — Reconciler-Sniper: entfernt verwaiste Subchat-
 * RAG-Chunks (source_type='subchat' ohne subchat_messages-Row). Fängt historische
 * Leaks (vor dem Cascade-Fix in deleteSubchat) + jeden zukünftigen Drift.
 * Idempotent. FTS folgt via Trigger. Für einen periodischen Timer geeignet.
 *
 *   LAZYOS_DB_PATH=./data/lazyos.db tsx scripts/purge-orphan-subchat-chunks.ts
 */
import { purgeOrphanSubchatChunks } from '@/lib/rag/indexer';

const res = purgeOrphanSubchatChunks();
console.log(JSON.stringify({ purgedOrphanSubchatChunks: res.deleted }));
process.exit(0);
