-- Program names (owner's decision, 2026-11-01): the names one program goes by in the files a workspace's payroll comes in
-- (the books' class, the payroll company's project or job), so a company-wide export is split by program without being
-- edited. A list of { names: string[], engagementId: string | null } (ProgramNames in packages/types), read from a
-- mapping file in the payroll zip's "Program names" folder and merged with each new one; owners keep it. Not a document:
-- the file is read in memory and never stored. Workspace_4_admin_lists keeps the platform admin from changing it.
ALTER TABLE "Workspace" ADD COLUMN "programNames" JSONB NOT NULL DEFAULT '[]';
