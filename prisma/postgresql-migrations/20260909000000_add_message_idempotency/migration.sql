BEGIN;

ALTER TABLE "Message"
ADD COLUMN "keyId" VARCHAR(100),
ADD COLUMN "remoteJid" VARCHAR(100),
ADD COLUMN "fromMe" BOOLEAN;

UPDATE "Message"
SET
  "keyId" = COALESCE(NULLIF("key"->>'id', ''), "id"),
  "remoteJid" = COALESCE("key"->>'remoteJid', ''),
  "fromMe" = CASE WHEN "key"->>'fromMe' = 'true' THEN true ELSE false END;

CREATE TEMPORARY TABLE "_MessageDeduplicationMap" ON COMMIT DROP AS
WITH ranked_messages AS (
  SELECT
    "id",
    FIRST_VALUE("id") OVER (
      PARTITION BY "instanceId", "keyId", "remoteJid", "fromMe"
      ORDER BY "messageTimestamp" ASC, "id" ASC
    ) AS "retainedId",
    ROW_NUMBER() OVER (
      PARTITION BY "instanceId", "keyId", "remoteJid", "fromMe"
      ORDER BY "messageTimestamp" ASC, "id" ASC
    ) AS duplicate_number
  FROM "Message"
)
SELECT
  "id" AS "duplicateId",
  "retainedId"
FROM ranked_messages
WHERE duplicate_number > 1;

CREATE UNIQUE INDEX "_MessageDeduplicationMap_duplicateId_key"
ON "_MessageDeduplicationMap"("duplicateId");

CREATE INDEX "_MessageDeduplicationMap_retainedId_idx"
ON "_MessageDeduplicationMap"("retainedId");

-- Preserve every status/update row that belonged to a redelivered message.
UPDATE "MessageUpdate" AS message_update
SET "messageId" = duplicate_message."retainedId"
FROM "_MessageDeduplicationMap" AS duplicate_message
WHERE message_update."messageId" = duplicate_message."duplicateId";

-- Media is one-to-one with Message. Prefer media already attached to the
-- retained message; otherwise retain the oldest media from its duplicates.
CREATE TEMPORARY TABLE "_MessageMediaSelection" ON COMMIT DROP AS
SELECT
  media."id" AS "mediaId",
  COALESCE(duplicate_message."retainedId", media."messageId") AS "retainedMessageId",
  ROW_NUMBER() OVER (
    PARTITION BY COALESCE(duplicate_message."retainedId", media."messageId")
    ORDER BY
      CASE WHEN duplicate_message."duplicateId" IS NULL THEN 0 ELSE 1 END,
      media."createdAt" ASC NULLS LAST,
      media."id" ASC
  ) AS "mediaNumber"
FROM "Media" AS media
LEFT JOIN "_MessageDeduplicationMap" AS duplicate_message
  ON duplicate_message."duplicateId" = media."messageId"
WHERE duplicate_message."duplicateId" IS NOT NULL
   OR EXISTS (
     SELECT 1
     FROM "_MessageDeduplicationMap" AS retained_message
     WHERE retained_message."retainedId" = media."messageId"
   );

DELETE FROM "Media" AS media
USING "_MessageMediaSelection" AS media_selection
WHERE media."id" = media_selection."mediaId"
  AND media_selection."mediaNumber" > 1;

UPDATE "Media" AS media
SET "messageId" = media_selection."retainedMessageId"
FROM "_MessageMediaSelection" AS media_selection
WHERE media."id" = media_selection."mediaId"
  AND media_selection."mediaNumber" = 1
  AND media."messageId" <> media_selection."retainedMessageId";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MessageUpdate" AS message_update
    INNER JOIN "_MessageDeduplicationMap" AS duplicate_message
      ON duplicate_message."duplicateId" = message_update."messageId"
  ) OR EXISTS (
    SELECT 1
    FROM "Media" AS media
    INNER JOIN "_MessageDeduplicationMap" AS duplicate_message
      ON duplicate_message."duplicateId" = media."messageId"
  ) THEN
    RAISE EXCEPTION 'Message deduplication left references attached to duplicate messages';
  END IF;
END $$;

DELETE FROM "Message" AS message
USING "_MessageDeduplicationMap" AS duplicate_message
WHERE message."id" = duplicate_message."duplicateId";

ALTER TABLE "Message"
ALTER COLUMN "keyId" SET DEFAULT gen_random_uuid()::text,
ALTER COLUMN "keyId" SET NOT NULL,
ALTER COLUMN "remoteJid" SET DEFAULT '',
ALTER COLUMN "remoteJid" SET NOT NULL,
ALTER COLUMN "fromMe" SET DEFAULT false,
ALTER COLUMN "fromMe" SET NOT NULL;

CREATE UNIQUE INDEX "Message_instanceId_keyId_remoteJid_fromMe_key"
ON "Message"("instanceId", "keyId", "remoteJid", "fromMe");

COMMIT;
