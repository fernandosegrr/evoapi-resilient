-- CreateTable
CREATE TABLE `LinkToken` (
    `id` VARCHAR(191) NOT NULL,
    `instanceId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `displayName` VARCHAR(100) NULL,
    `allowReset` BOOLEAN NOT NULL DEFAULT false,
    `expectedNumber` VARCHAR(20) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `consumedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `autoResets` INTEGER NOT NULL DEFAULT 0,
    `windowStartedAt` DATETIME(3) NULL,
    `windowAttempts` INTEGER NOT NULL DEFAULT 0,
    `lastAttemptAt` DATETIME(3) NULL,

    UNIQUE INDEX `LinkToken_tokenHash_key`(`tokenHash`),
    INDEX `LinkToken_instanceId_idx`(`instanceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LinkToken` ADD CONSTRAINT `LinkToken_instanceId_fkey` FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

