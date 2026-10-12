-- A deletion's export can be split into several zips (a big engagement passes what one zip or one request can
-- carry). `parts` holds one entry per zip: its number, file name, the paths of the files it holds, the key of our
-- retained copy, whether the owner's download of it finished, and the exact bytes and sha256 that were sent.
-- The record is 'downloaded' only when every part is. Records made before this have no parts ('[]').
ALTER TABLE "DeletionRecord" ADD COLUMN "parts" JSONB NOT NULL DEFAULT '[]';
