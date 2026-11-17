START TRANSACTION;

ALTER TABLE `IsOnWhatsapp`
  DROP FOREIGN KEY `IsOnWhatsapp_instanceId_fkey`;

DROP INDEX `IsOnWhatsapp_remoteJid_instanceId_key` ON `IsOnWhatsapp`;
DROP INDEX `IsOnWhatsapp_instanceId_idx` ON `IsOnWhatsapp`;

-- The old schema allowed only one row per remoteJid. Keep the newest cache row
-- if tenant-scoped writes created duplicates after the forward migration.
DELETE older
FROM `IsOnWhatsapp` AS older
INNER JOIN `IsOnWhatsapp` AS newer
  ON newer.`remoteJid` = older.`remoteJid`
 AND (
   newer.`updatedAt` > older.`updatedAt`
   OR (newer.`updatedAt` = older.`updatedAt` AND newer.`id` > older.`id`)
 );

ALTER TABLE `IsOnWhatsapp` DROP COLUMN `instanceId`;
CREATE UNIQUE INDEX `IsOnWhatsapp_remoteJid_key` ON `IsOnWhatsapp`(`remoteJid`);

COMMIT;
