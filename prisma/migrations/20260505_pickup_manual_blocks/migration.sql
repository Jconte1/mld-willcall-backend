CREATE TABLE "PickupManualBlock" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "locationId" VARCHAR(64) NOT NULL,
  "date" VARCHAR(10) NOT NULL,
  "startTime" VARCHAR(5) NOT NULL,
  "createdByUserId" VARCHAR(64),

  CONSTRAINT "PickupManualBlock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PickupManualBlock_locationId_date_startTime_key"
ON "PickupManualBlock"("locationId", "date", "startTime");

CREATE INDEX "PickupManualBlock_locationId_date_idx"
ON "PickupManualBlock"("locationId", "date");
