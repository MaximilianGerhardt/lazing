#!/usr/bin/env tsx
/**
 * purge-orphan-subchat-chunks — reconciler sniper: removes orphaned subchat
 * RAG chunks (source_type='subchat' without a subchat_messages row). Catches
 * historical leaks (before the cascade fix in deleteSubchat) + any future drift.
 * Idempotent. FTS follows via trigger. Suited for a periodic timer.
 *
 *   LAZYOS_DB_PATH=./data/lazyos.db tsx scripts/purge-orphan-subchat-chunks.ts
 */
import { purgeOrphanSubchatChunks } from '@/lib/rag/indexer';

const res = purgeOrphanSubchatChunks();
console.log(JSON.stringify({ purgedOrphanSubchatChunks: res.deleted }));
process.exit(0);
