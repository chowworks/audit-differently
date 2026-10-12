-- Objects are filed by workspace, then by engagement: <workspaceId>/<engagementId>/<period or general>/<uuid>.
-- A document that belongs to no engagement files under <workspaceId>/workspace/. The trigger from migration
-- 20261011000600 now checks the engagement segment too, so two engagements of one workspace never share a
-- folder and a row can never point at another engagement's object.
CREATE OR REPLACE FUNCTION "document_key_in_workspace"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  prefix TEXT := NEW."workspaceId" || '/' || COALESCE(NEW."engagementId", 'workspace') || '/';
BEGIN
  IF NEW."storageKey" IS NULL OR position(prefix IN NEW."storageKey") <> 1 THEN
    RAISE EXCEPTION 'Document %: storage key must start with its workspace id and engagement id', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER "Document_4_key" ON "Document";
CREATE TRIGGER "Document_4_key" BEFORE INSERT OR UPDATE OF "storageKey", "workspaceId", "engagementId" ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "document_key_in_workspace"();
