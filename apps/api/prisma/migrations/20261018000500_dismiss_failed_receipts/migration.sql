-- An emailed receipt that failed (the provider or our reading gave up after its attempts) may be dismissed too, with a
-- reason from the same fixed list, so it does not wait in the inbox forever (owner's decision, 2026-10-18). A dismissed
-- one still changes no further.

CREATE OR REPLACE FUNCTION "inbound_receipt_dismissed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'dismissed' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A dismissed emailed receipt stays dismissed' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'dismissed' AND OLD."status" IS DISTINCT FROM 'dismissed'
     AND OLD."status" NOT IN ('unmatched', 'failed') THEN
    RAISE EXCEPTION 'Only an emailed receipt that needs filing or failed is dismissed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "inbound_receipt_dismissed"() FROM PUBLIC;
