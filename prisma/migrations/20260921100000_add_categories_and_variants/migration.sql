-- ===== 1. New tables (no foreign keys yet — added at the end once data is backfilled) =====
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "colorHex" TEXT NOT NULL,
    "views" "ProductView"[],
    "imageUrls" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VariantSize" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "size" TEXT NOT NULL,

    CONSTRAINT "VariantSize_pkey" PRIMARY KEY ("id")
);

-- ===== 2. Backfill: one Category per distinct existing Product.category string =====
INSERT INTO "Category" ("id", "name", "slug")
SELECT gen_random_uuid()::text,
       c."category",
       lower(regexp_replace(trim(c."category"), '[^a-zA-Z0-9]+', '-', 'g'))
FROM (SELECT DISTINCT "category" FROM "Product") c;

-- ===== 3. Product.category (string) -> Product.categoryId (FK) =====
ALTER TABLE "Product" ADD COLUMN "categoryId" TEXT;

UPDATE "Product" p
SET "categoryId" = cat."id"
FROM "Category" cat
WHERE cat."name" = p."category";

ALTER TABLE "Product" ALTER COLUMN "categoryId" SET NOT NULL;

-- ===== 4. Backfill: one ProductVariant per existing Product, carrying its current color/images =====
INSERT INTO "ProductVariant" ("id", "productId", "color", "colorHex", "views", "imageUrls", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, p."id", p."color", p."colorHex", p."views", p."imageUrls", true, now(), now()
FROM "Product" p;

-- ===== 5. Backfill VariantSize from the distinct (product, size) pairs already in use =====
INSERT INTO "VariantSize" ("id", "variantId", "size")
SELECT gen_random_uuid()::text, pv."id", g."size"
FROM (SELECT DISTINCT "productId", "size" FROM "GarmentUnit") g
JOIN "ProductVariant" pv ON pv."productId" = g."productId";

-- ===== 6. Point every existing GarmentUnit at its product's (sole, just-backfilled) variant =====
ALTER TABLE "GarmentUnit" ADD COLUMN "variantId" TEXT;

UPDATE "GarmentUnit" g
SET "variantId" = pv."id"
FROM "ProductVariant" pv
WHERE pv."productId" = g."productId";

ALTER TABLE "GarmentUnit" ALTER COLUMN "variantId" SET NOT NULL;

-- ===== 7. Drop the now-superseded columns/constraints/indexes =====
ALTER TABLE "GarmentUnit" DROP CONSTRAINT "GarmentUnit_productId_fkey";
DROP INDEX "GarmentUnit_productId_size_stage_idx";
ALTER TABLE "GarmentUnit" DROP COLUMN "productId";

DROP INDEX "Product_category_idx";
ALTER TABLE "Product" DROP COLUMN "category",
DROP COLUMN "color",
DROP COLUMN "colorHex",
DROP COLUMN "imageUrls",
DROP COLUMN "views";

-- ===== 8. New indexes + foreign keys =====
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");
CREATE UNIQUE INDEX "ProductVariant_productId_color_key" ON "ProductVariant"("productId", "color");
CREATE UNIQUE INDEX "VariantSize_variantId_size_key" ON "VariantSize"("variantId", "size");
CREATE INDEX "GarmentUnit_variantId_size_stage_idx" ON "GarmentUnit"("variantId", "size", "stage");
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VariantSize" ADD CONSTRAINT "VariantSize_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GarmentUnit" ADD CONSTRAINT "GarmentUnit_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
