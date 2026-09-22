-- CreateTable
CREATE TABLE "OccasionTile" (
    "occasion" "Occasion" NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "blurb" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OccasionTile_pkey" PRIMARY KEY ("occasion")
);
