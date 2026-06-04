-- ============================================================
-- 0097_rag_fts.sql — Lexical-RAG FTS5 (N7: lexical before vector)
--
-- Datum:  2026-05-24
-- Autor:  Claude Code (Lexical-RAG sprint, Task #41 Batch1·1d)
-- N7:     Lexical RAG ships before vector sophistication.
-- N2:     FTS query is always workspace-filtered via JOIN on rag_chunks
--         — no cross-scope leak possible from the FTS table alone.
--
-- Strategy:
--   * content= FTS5 ("content table" mode) — the virtual table stores
--     only the FTS index, not a copy of the text. Row identity maps
--     1:1 with rag_chunks.rowid via the content= directive.
--   * content_rowid= 'rowid' — SQLite assigns an implicit integer rowid
--     to TEXT-PK tables. Because rag_chunks.id is TEXT PK, SQLite still
--     gives each row a hidden rowid. The FTS rowid is kept in sync with
--     rag_chunks.rowid via the triggers below.
--   * BM25 ranking via bm25(rag_chunks_fts) — negative values, lower
--     is better; retriever orders ASC.
--   * Trigram tokeniser not used (requires SQLite ≥ 3.45 and is an
--     optional build; porter tokeniser is always available).
--     For German compound words + English mixed content, unicode61 is
--     the best baseline in stock SQLite.
--
-- Idempotent: all CREATE / INSERT statements use IF NOT EXISTS / OR IGNORE.
-- ============================================================

-- 1. FTS5 virtual table (content table referencing rag_chunks.text)
--    content_rowid is the hidden integer rowid of rag_chunks, not the TEXT PK.
CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts
USING fts5(
  text,
  content=rag_chunks,
  content_rowid=rowid,
  tokenize='unicode61'
);

-- 2. Keep FTS index in sync with rag_chunks via three triggers.
--    Each trigger fires AFTER the DML so the rag_chunks row already exists
--    (or is gone) when the FTS is updated.

-- 2a. After INSERT: add new chunk to FTS index.
CREATE TRIGGER IF NOT EXISTS trg_rag_chunks_fts_insert
AFTER INSERT ON rag_chunks
BEGIN
  INSERT INTO rag_chunks_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
END;

-- 2b. After UPDATE of text: update FTS index by deleting old entry then
--     inserting the new one (FTS5 content tables require explicit delete+insert).
CREATE TRIGGER IF NOT EXISTS trg_rag_chunks_fts_update
AFTER UPDATE OF text ON rag_chunks
BEGIN
  INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, text)
    VALUES ('delete', OLD.rowid, OLD.text);
  INSERT INTO rag_chunks_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
END;

-- 2c. After DELETE: remove chunk from FTS index.
CREATE TRIGGER IF NOT EXISTS trg_rag_chunks_fts_delete
AFTER DELETE ON rag_chunks
BEGIN
  INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, text)
    VALUES ('delete', OLD.rowid, OLD.text);
END;

-- 3. Backfill: rebuild the FTS index from all existing rag_chunks rows.
--    'rebuild' is the canonical FTS5 command for this: it clears the
--    existing index and re-reads from the content table (rag_chunks).
--    Safe to run on an empty table (no-op) or a populated one.
--    On re-run (idempotent): rebuild is always safe — it replaces the
--    index rather than duplicating it.
INSERT INTO rag_chunks_fts(rag_chunks_fts) VALUES ('rebuild');
