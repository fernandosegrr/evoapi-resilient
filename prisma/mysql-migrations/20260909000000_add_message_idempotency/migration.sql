ALTER TABLE `Message`
ADD COLUMN `keyId` VARCHAR(100) NULL,
ADD COLUMN `remoteJid` VARCHAR(100) NULL,
ADD COLUMN `fromMe` BOOLEAN NULL;

UPDATE `Message`
SET
  `keyId` = COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(`key`, '$.id')), ''), `id`),
  `remoteJid` = COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`key`, '$.remoteJid')), ''),
  `fromMe` = CASE
    WHEN JSON_UNQUOTE(JSON_EXTRACT(`key`, '$.fromMe')) = 'true' THEN TRUE
    ELSE FALSE
  END;

CREATE TEMPORARY TABLE `_MessageDeduplicationMap` AS
SELECT
  `id` AS `duplicateId`,
  `retainedId`
FROM (
  SELECT
    `id`,
    FIRST_VALUE(`id`) OVER (
      PARTITION BY `instanceId`, `keyId`, `remoteJid`, `fromMe`
      ORDER BY `messageTimestamp` ASC, `id` ASC
    ) AS `retainedId`,
    ROW_NUMBER() OVER (
      PARTITION BY `instanceId`, `keyId`, `remoteJid`, `fromMe`
      ORDER BY `messageTimestamp` ASC, `id` ASC
    ) AS duplicate_number
  FROM `Message`
) AS ranked_messages
WHERE duplicate_number > 1;

CREATE UNIQUE INDEX `_MessageDeduplicationMap_duplicateId_key`
ON `_MessageDeduplicationMap`(`duplicateId`);

CREATE INDEX `_MessageDeduplicationMap_retainedId_idx`
ON `_MessageDeduplicationMap`(`retainedId`);

UPDATE `MessageUpdate` AS message_update
INNER JOIN `_MessageDeduplicationMap` AS duplicate_message
  ON duplicate_message.`duplicateId` = message_update.`messageId`
SET message_update.`messageId` = duplicate_message.`retainedId`;

CREATE TEMPORARY TABLE `_MessageDeduplicationKeepers` AS
SELECT DISTINCT `retainedId`
FROM `_MessageDeduplicationMap`;

CREATE TEMPORARY TABLE `_MessageMediaCandidates` AS
SELECT
  media.`id` AS `mediaId`,
  duplicate_message.`retainedId` AS `retainedMessageId`,
  1 AS `retainedPriority`,
  media.`createdAt`
FROM `Media` AS media
INNER JOIN `_MessageDeduplicationMap` AS duplicate_message
  ON duplicate_message.`duplicateId` = media.`messageId`
UNION ALL
SELECT
  media.`id` AS `mediaId`,
  retained_message.`retainedId` AS `retainedMessageId`,
  0 AS `retainedPriority`,
  media.`createdAt`
FROM `Media` AS media
INNER JOIN `_MessageDeduplicationKeepers` AS retained_message
  ON retained_message.`retainedId` = media.`messageId`;

CREATE TEMPORARY TABLE `_MessageMediaSelection` AS
SELECT
  `mediaId`,
  `retainedMessageId`,
  ROW_NUMBER() OVER (
    PARTITION BY `retainedMessageId`
    ORDER BY `retainedPriority` ASC, `createdAt` IS NULL ASC, `createdAt` ASC, `mediaId` ASC
  ) AS `mediaNumber`
FROM `_MessageMediaCandidates`;

DELETE media
FROM `Media` AS media
INNER JOIN `_MessageMediaSelection` AS media_selection
  ON media_selection.`mediaId` = media.`id`
WHERE media_selection.`mediaNumber` > 1;

UPDATE `Media` AS media
INNER JOIN `_MessageMediaSelection` AS media_selection
  ON media_selection.`mediaId` = media.`id`
  AND media_selection.`mediaNumber` = 1
SET media.`messageId` = media_selection.`retainedMessageId`
WHERE media.`messageId` <> media_selection.`retainedMessageId`;

DELETE message_to_delete
FROM `Message` AS message_to_delete
INNER JOIN `_MessageDeduplicationMap` AS duplicate_message
  ON duplicate_message.`duplicateId` = message_to_delete.`id`;

ALTER TABLE `Message`
MODIFY `keyId` VARCHAR(100) NOT NULL,
MODIFY `remoteJid` VARCHAR(100) NOT NULL DEFAULT '',
MODIFY `fromMe` BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX `Message_instanceId_keyId_remoteJid_fromMe_key`
ON `Message`(`instanceId`, `keyId`, `remoteJid`, `fromMe`);

DROP TEMPORARY TABLE `_MessageMediaSelection`;
DROP TEMPORARY TABLE `_MessageMediaCandidates`;
DROP TEMPORARY TABLE `_MessageDeduplicationKeepers`;
DROP TEMPORARY TABLE `_MessageDeduplicationMap`;
