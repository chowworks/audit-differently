-- Participants' pay from their pay stubs (GitHub issue #22; owner's decisions, 2026-10-18). The workspace payroll match
-- reads each pay stub's pay period and pay, finds the participant it names on an engagement's participant list
-- (step 5), and makes their work-experience payment on that engagement's month from it: the bookkeeper never types it.

-- 1. The payment made from a pay stub names it, so matching the period again changes that payment rather than adding a
-- second one. A plain id, as ReportReopening.signedDocumentId: no foreign key, so removing a document never writes to
-- a payment (which a closed or submitted month refuses). One payment per stub.
ALTER TABLE "WexPayment" ADD COLUMN "stubDocumentId" TEXT;
CREATE UNIQUE INDEX "WexPayment_stubDocumentId_key" ON "WexPayment"("stubDocumentId");
-- A payment typed by hand that a stub took over (the same participant and pay period): if that stub ever leaves the
-- month's payroll files, the payment stays, no longer tied to it; a payment the stub made goes with it.
ALTER TABLE "WexPayment" ADD COLUMN "stubTookOver" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WexPayment" ADD CONSTRAINT "WexPayment_stubTookOver_check" CHECK (NOT "stubTookOver" OR "stubDocumentId" IS NOT NULL);

-- It names a pay stub of its own workspace. Read as the caller, so another workspace's document and none at all read
-- alike.
CREATE FUNCTION "wex_payment_stub_document"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."stubDocumentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Document" WHERE "id" = NEW."stubDocumentId" AND "workspaceId" = NEW."workspaceId" AND "kind" = 'paystub'
  ) THEN
    RAISE EXCEPTION 'A work-experience payment names a pay stub of its workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "wex_payment_stub_document"() FROM PUBLIC;
CREATE TRIGGER "WexPayment_2_stub_document" BEFORE INSERT OR UPDATE OF "stubDocumentId" ON "WexPayment"
  FOR EACH ROW EXECUTE FUNCTION "wex_payment_stub_document"();

-- 2. What a kept pay was flagged for when it was last matched (PAY_LINE_FLAGS in packages/types). A pay stub: its pay or
-- pay period unreadable, nobody or several people on the participant lists, no month for the participant's engagement,
-- a bank payment that disagrees, or a second stub of a pay period already paid. A register row: which amount is this
-- period's pay can't be told. Flagged only; matching again rewrites them.
ALTER TABLE "PayrollPayLine" ADD COLUMN "flags" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "PayrollPayLine" ADD CONSTRAINT "PayrollPayLine_flags_check" CHECK ("flags" <@ ARRAY[
  'stub-unreadable', 'no-participant', 'several-participants', 'no-month', 'bank-disagrees', 'duplicate',
  'pay-unclear']::TEXT[]);

-- Once found, a line stays as it was read: only the owner's not-grant-funded word and the flags change.
CREATE OR REPLACE FUNCTION "payroll_pay_line_decision_only"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['notFundedReason', 'notFundedById', 'notFundedByEmail', 'notFundedAt', 'flags'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['notFundedReason', 'notFundedById', 'notFundedByEmail', 'notFundedAt', 'flags']) THEN
    RAISE EXCEPTION 'A pay line changes only by being marked not grant-funded or matched again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "payroll_pay_line_decision_only"() FROM PUBLIC;
