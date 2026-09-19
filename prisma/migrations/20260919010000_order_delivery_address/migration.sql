-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN "deliveryName" TEXT,
  ADD COLUMN "deliveryEmail" TEXT,
  ADD COLUMN "deliveryPhone" TEXT,
  ADD COLUMN "deliveryAddressLine1" TEXT,
  ADD COLUMN "deliveryAddressLine2" TEXT,
  ADD COLUMN "deliveryState" TEXT,
  ADD COLUMN "deliveryPostalCode" TEXT,
  ADD COLUMN "deliveryCountry" TEXT,
  ADD COLUMN "deliveryNote" TEXT;
