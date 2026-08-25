ALTER TABLE "OrderReadyJobState"
ADD COLUMN "businessDate" VARCHAR(10),
ADD COLUMN "startedAt" TIMESTAMP(3),
ADD COLUMN "completedAt" TIMESTAMP(3),
ADD COLUMN "status" VARCHAR(32),
ADD COLUMN "rowCount" INTEGER,
ADD COLUMN "orderCount" INTEGER,
ADD COLUMN "errorSummary" TEXT;

CREATE INDEX "OrderReadyJobState_name_businessDate_idx"
ON "OrderReadyJobState"("name", "businessDate");
