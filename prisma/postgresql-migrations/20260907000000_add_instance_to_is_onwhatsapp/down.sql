BEGIN;

ALTER TABLE "IsOnWhatsapp"
  DROP CONSTRAINT IF EXISTS "IsOnWhatsapp_instanceId_fkey";

DROP INDEX IF EXISTS "IsOnWhatsapp_remoteJid_instanceId_key";
DROP INDEX IF EXISTS "IsOnWhatsapp_instanceId_idx";

-- The old schema allowed only one row per remoteJid. Keep the newest cache row
-- if tenant-scoped writes created duplicates after the forward migration.
DELETE FROM "IsOnWhatsapp"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "remoteJid"
        ORDER BY "updatedAt" DESC, "id" DESC
      ) AS row_number
    FROM "IsOnWhatsapp"
  ) ranked
  WHERE ranked.row_number > 1
);

ALTER TABLE "IsOnWhatsapp" DROP COLUMN "instanceId";
CREATE UNIQUE INDEX "IsOnWhatsapp_remoteJid_key" ON "IsOnWhatsapp"("remoteJid");

COMMIT;
