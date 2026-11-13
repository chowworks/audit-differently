-- How the books charge a shared cost to every program (owner's decision, 2026-11-12): the dollars an allocation entry,
-- or a bill split by class, gives each class, kept on the line Save writes (BooksSplitDto in packages/types). The
-- export's copy opens with a note of it, and the line's rows of the entry are highlighted on the export.
ALTER TABLE "Expense" ADD COLUMN "booksSplit" JSONB;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_booksSplit_check"
  CHECK ("booksSplit" IS NULL OR ("booksKey" IS NOT NULL AND jsonb_typeof("booksSplit") = 'object'));
