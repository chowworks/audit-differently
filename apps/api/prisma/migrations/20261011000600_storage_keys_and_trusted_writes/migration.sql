-- A document's object lives under its workspace: every storage key starts with the workspace id and a slash.
-- The API builds keys that way (documents.service.ts); the database now refuses any other key, however the
-- row is written, so a Document row can never point at another workspace's object. Runs after the triggers
-- that settle the row's workspace (alphabetical trigger order).
CREATE FUNCTION "document_key_in_workspace"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."storageKey" IS NULL OR position(NEW."workspaceId" || '/' IN NEW."storageKey") <> 1 THEN
    RAISE EXCEPTION 'Document %: storage key must start with its workspace id', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Document_4_key" BEFORE INSERT OR UPDATE OF "storageKey", "workspaceId" ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "document_key_in_workspace"();
REVOKE ALL ON FUNCTION "document_key_in_workspace"() FROM PUBLIC;

-- Trusted writes, narrowed to exactly what the API does with them (migrations 20261011000400 and ..0500
-- opened them): a Workspace is created by trusted work only, since the creator's first membership comes with
-- it, and trusted work removes placeholder rows only.
DROP POLICY "tenant_insert" ON "Workspace";
CREATE POLICY "tenant_insert" ON "Workspace" FOR INSERT
  WITH CHECK ((SELECT "app_is_system"()));
DROP POLICY "tenant_delete" ON "User";
CREATE POLICY "tenant_delete" ON "User" FOR DELETE
  USING ((SELECT "app_is_system"()) AND "id" LIKE 'pending-%');
