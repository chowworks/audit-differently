-- No employee numbers on the staff list (owner's decision, 2026-10-18: "We should not be tracking stuff like employee
-- numbers"; GitHub issue #22). The column, its check and its unique index go, and a person's name becomes their only
-- key: one person of a name per workspace, whatever its case. The name is already trimmed (StaffMember_name_check) and
-- the API folds its inner spaces to one, so lower("name") is the whole comparison. Two people who share a name are told
-- apart by the owner (the API asks for something added to one name, e.g. "Morgan Lee (Adult IT)"); the payroll match
-- never guesses between them.

-- A workspace that already has two people of one name (they were told apart by their numbers) keeps both: every one
-- after the first, oldest first, gets " (2)", " (3)" and so on, kept within the 120 characters a name may have, for the
-- owner to rename. (Fictional seed data only on the shared databases; nothing is removed.)
UPDATE "StaffMember" s
SET "name" = left(d."name", 120 - char_length(' (' || d.n || ')')) || ' (' || d.n || ')'
FROM (
  SELECT "id", "name",
         row_number() OVER (PARTITION BY "workspaceId", lower("name") ORDER BY "createdAt", "id") AS n
  FROM "StaffMember"
) d
WHERE s."id" = d."id" AND d.n > 1;

DROP INDEX "StaffMember_workspaceId_employeeNumber_key";
ALTER TABLE "StaffMember" DROP CONSTRAINT "StaffMember_employeeNumber_check";
ALTER TABLE "StaffMember" DROP COLUMN "employeeNumber";

CREATE UNIQUE INDEX "StaffMember_workspaceId_name_key" ON "StaffMember"("workspaceId", lower("name"));
