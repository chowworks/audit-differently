-- "Bookkeepers see payroll" becomes "Bookkeepers see staff payroll" (GitHub issue #22; owner's decision, 2026-10-18):
-- on by default; off, a bookkeeper's month page shows the payroll section with its proofs as labels rather than links
-- to the files. The screen only: the API answers the same data. Participants' pay comes from their stubs either way.
-- Workspace_4_admin_lists admits only the name and the lists, so the platform admin still never sets it.
ALTER TABLE "Workspace" RENAME COLUMN "bookkeepersSeePayroll" TO "bookkeepersSeeStaffPayroll";
