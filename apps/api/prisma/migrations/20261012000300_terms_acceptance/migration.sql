-- Everyone who signs in accepts the Terms, and again whenever their wording changes. "fingerprint" is the version of
-- the Terms: 16 hex characters of the hash of their wording (apps/api/src/auth/terms-fingerprint.ts). One row per
-- person per fingerprint, kept as proof of what was accepted and when.
--
-- No foreign key to "User" on purpose: the record outlives the person's row (an invitation's placeholder is deleted
-- when the real account takes it over, and a person may be removed), like DeletionRecord and DataAccessLog.
-- It carries no workspaceId: acceptance belongs to the person, not to a workspace, so there is no set_tenant trigger.
CREATE TABLE "TermsAcceptance" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TermsAcceptance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TermsAcceptance_userId_fingerprint_key" ON "TermsAcceptance"("userId", "fingerprint");

-- Append-only: a person inserts and reads their own rows. There is no update or delete policy, so the restricted
-- role can do neither (not even for system work).
ALTER TABLE "TermsAcceptance" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "TermsAcceptance" FOR SELECT
  USING ("userId" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_insert" ON "TermsAcceptance" FOR INSERT
  WITH CHECK ("userId" = (SELECT "app_user_id"()));
