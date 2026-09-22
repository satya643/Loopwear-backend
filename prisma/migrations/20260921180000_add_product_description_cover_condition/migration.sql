-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "conditionCopy" TEXT NOT NULL DEFAULT 'Excellent condition, inspected before dispatch',
ADD COLUMN     "coverImageUrl" TEXT,
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '';
