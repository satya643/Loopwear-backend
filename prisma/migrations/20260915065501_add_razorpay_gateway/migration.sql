-- AlterEnum
ALTER TYPE "PaymentGateway" ADD VALUE 'razorpay';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "gatewayPaymentRef" TEXT;
