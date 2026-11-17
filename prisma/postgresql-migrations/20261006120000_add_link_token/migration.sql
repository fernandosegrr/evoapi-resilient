-- CreateTable
CREATE TABLE "LinkToken" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "displayName" VARCHAR(100),
    "allowReset" BOOLEAN NOT NULL DEFAULT false,
    "expectedNumber" VARCHAR(20),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "autoResets" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3),
    "windowAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),

    CONSTRAINT "LinkToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkToken_tokenHash_key" ON "LinkToken"("tokenHash");

-- CreateIndex
CREATE INDEX "LinkToken_instanceId_idx" ON "LinkToken"("instanceId");

-- AddForeignKey
ALTER TABLE "LinkToken" ADD CONSTRAINT "LinkToken_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

