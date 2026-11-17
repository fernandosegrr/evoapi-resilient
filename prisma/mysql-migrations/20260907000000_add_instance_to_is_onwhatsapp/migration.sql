-- AlterTable
ALTER TABLE `IsOnWhatsapp` ADD COLUMN `instanceId` VARCHAR(191) NULL;

-- Replace the global remoteJid uniqueness with tenant-scoped uniqueness.
DROP INDEX `IsOnWhatsapp_remoteJid_key` ON `IsOnWhatsapp`;
CREATE UNIQUE INDEX `IsOnWhatsapp_remoteJid_instanceId_key`
  ON `IsOnWhatsapp`(`remoteJid`, `instanceId`);
CREATE INDEX `IsOnWhatsapp_instanceId_idx` ON `IsOnWhatsapp`(`instanceId`);

-- Existing rows remain unscoped (NULL) and are preserved.
ALTER TABLE `IsOnWhatsapp`
  ADD CONSTRAINT `IsOnWhatsapp_instanceId_fkey`
  FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
