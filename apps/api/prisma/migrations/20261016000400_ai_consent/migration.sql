-- AI only with a yes (owner's decision, 2026-10-16). A person says yes on screen each time (the import's "Suggest the
-- mapping with AI" button, the receipt upload's box), and the API never remembers it. An emailed receipt has nobody
-- present to ask, so its yes is this workspace setting, kept by the owners: off until an owner turns it on.
ALTER TABLE "Workspace" ADD COLUMN "readEmailedReceiptsWithAi" BOOLEAN NOT NULL DEFAULT false;

-- The platform admin never sets it. Changing it in a workspace the admin does not own is already refused by
-- Workspace_4_admin_lists (the column is not among the name and lists it admits); this keeps the admin from creating
-- a workspace with it on. An admin seated as the workspace's owner changes it as that owner, through the owner's page.
CREATE FUNCTION "workspace_ai_owners_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "app_is_admin"() AND NEW."readEmailedReceiptsWithAi" THEN
    RAISE EXCEPTION 'Only the owners of a workspace turn on reading emailed receipts with AI' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Workspace_7_ai_owners_only" BEFORE INSERT ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION "workspace_ai_owners_only"();
REVOKE ALL ON FUNCTION "workspace_ai_owners_only"() FROM PUBLIC;
