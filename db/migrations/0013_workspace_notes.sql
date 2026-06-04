-- 0013: workspace editor (user feedback 2026-04-25)
--
-- Allows manual AND AI-generated notes per workspace, in the style of a
-- mini-CLAUDE.md file. `description` is the short form (one line, visible in
-- the top bar/list), `notes` is the markdown long form (editor page).

ALTER TABLE workspaces ADD COLUMN description TEXT;
ALTER TABLE workspaces ADD COLUMN notes TEXT;
ALTER TABLE workspaces ADD COLUMN notes_updated_at INTEGER;
ALTER TABLE workspaces ADD COLUMN notes_source TEXT;
-- notes_source: 'manual' | 'ai-summary' | null
