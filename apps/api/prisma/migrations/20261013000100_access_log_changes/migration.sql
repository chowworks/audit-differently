-- The access log says what a person did in the words of the screen they did it on (`description`), and for a
-- change, which fields it touched (`changes`: a list of {field, before?, after?}). A personal or free-text field is
-- kept as its name alone, never its value (src/core/changes.ts). Both are null on lines written before this.
--
-- The table keeps its policies from 20261011000100: written by whoever acts, in their own workspace, read there,
-- never changed or removed. Table-level grants cover the new columns, so nothing else changes.
ALTER TABLE "DataAccessLog" ADD COLUMN "description" TEXT;
ALTER TABLE "DataAccessLog" ADD COLUMN "changes" JSONB;
