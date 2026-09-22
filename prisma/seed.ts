import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("Password123!", 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@loopwear.dev" },
    update: {},
    create: {
      name: "Ops Admin",
      email: "admin@loopwear.dev",
      phone: "+919800000001",
      passwordHash,
      verified: true,
      role: "admin",
      country: "IN",
    },
  });

  const customer = await prisma.user.upsert({
    where: { email: "customer@loopwear.dev" },
    update: {},
    create: {
      name: "Asha Rao",
      email: "customer@loopwear.dev",
      phone: "+919800000002",
      passwordHash,
      verified: true,
      role: "customer",
      country: "IN",
    },
  });

  const facility = await prisma.facility.upsert({
    where: { id: "seed-facility-blr" },
    update: {},
    create: { id: "seed-facility-blr", name: "Bengaluru Hub", city: "Bengaluru" },
  });

  await prisma.courier.upsert({
    where: { id: "seed-courier-1" },
    update: {},
    create: { id: "seed-courier-1", name: "Ravi Kumar", zones: ["Indiranagar", "Koramangala"] },
  });

  const blazersCategory = await prisma.category.upsert({
    where: { name: "Blazers" },
    update: {},
    create: { id: "seed-category-blazers", name: "Blazers", slug: "blazers" },
  });

  const gownsCategory = await prisma.category.upsert({
    where: { name: "Gowns" },
    update: {},
    create: { id: "seed-category-gowns", name: "Gowns", slug: "gowns" },
  });

  const blazer = await prisma.product.upsert({
    where: { id: "seed-product-blazer" },
    update: {},
    create: {
      id: "seed-product-blazer",
      name: "Midnight Linen Blazer",
      brand: "Vestige",
      categoryId: blazersCategory.id,
      occasions: ["Office", "DateNight"],
      styles: ["Formal", "Minimal"],
      rentPricePaise: 149900,
      rentDays: 4,
      buyPricePaise: 649900,
      depositPaise: 150000,
      deliveryDays: 2,
      fabric: "Linen blend",
      care: ["Dry clean only"],
      measurements: [
        { label: "Chest", value: "40in" },
        { label: "Length", value: "28in" },
      ],
    },
  });

  const blazerNavyVariant = await prisma.productVariant.upsert({
    where: { productId_color: { productId: blazer.id, color: "Midnight Navy" } },
    update: {},
    create: {
      id: "seed-variant-blazer-navy",
      productId: blazer.id,
      color: "Midnight Navy",
      colorHex: "#1B2340",
      views: ["front", "back", "fabric"],
      imageUrls: { front: "https://example.com/blazer-front.jpg" },
      sizes: { create: [{ size: "M" }, { size: "L" }] },
    },
  });

  const gown = await prisma.product.upsert({
    where: { id: "seed-product-gown" },
    update: {},
    create: {
      id: "seed-product-gown",
      name: "Emerald Silk Gown",
      brand: "Vestige",
      categoryId: gownsCategory.id,
      occasions: ["Wedding", "Party"],
      styles: ["Classic", "Contemporary"],
      rentPricePaise: 249900,
      rentDays: 3,
      buyPricePaise: 1249900,
      depositPaise: 300000,
      deliveryDays: 2,
      fabric: "Silk",
      care: ["Dry clean only"],
      measurements: [{ label: "Bust", value: "36in" }],
    },
  });

  const gownEmeraldVariant = await prisma.productVariant.upsert({
    where: { productId_color: { productId: gown.id, color: "Emerald" } },
    update: {},
    create: {
      id: "seed-variant-gown-emerald",
      productId: gown.id,
      color: "Emerald",
      colorHex: "#0B6E4F",
      views: ["front", "back", "model"],
      imageUrls: { front: "https://example.com/gown-front.jpg" },
      sizes: { create: [{ size: "S" }, { size: "M" }] },
    },
  });

  const units: { variantId: string; size: string; sku: string }[] = [
    { variantId: blazerNavyVariant.id, size: "M", sku: "BLZ-M-001" },
    { variantId: blazerNavyVariant.id, size: "M", sku: "BLZ-M-002" },
    { variantId: blazerNavyVariant.id, size: "L", sku: "BLZ-L-001" },
    { variantId: gownEmeraldVariant.id, size: "S", sku: "GWN-S-001" },
    { variantId: gownEmeraldVariant.id, size: "M", sku: "GWN-M-001" },
  ];

  for (const u of units) {
    await prisma.garmentUnit.upsert({
      where: { sku: u.sku },
      update: {},
      create: { sku: u.sku, variantId: u.variantId, size: u.size, facilityId: facility.id },
    });
  }

  await prisma.outfit.upsert({
    where: { id: "seed-outfit-office" },
    update: {},
    create: {
      id: "seed-outfit-office",
      name: "Boardroom Ready",
      occasion: "Office",
      lookRentPricePaise: 199900,
      lookBuyPricePaise: 899900,
      lookRentDays: 4,
      outfitProducts: { create: [{ productId: blazer.id, position: 0 }] },
    },
  });

  await prisma.fxRate.upsert({
    where: { baseCurrency_targetCurrency: { baseCurrency: "INR", targetCurrency: "USD" } },
    update: {},
    create: { baseCurrency: "INR", targetCurrency: "USD", rate: 0.012 },
  });

  // eslint-disable-next-line no-console
  console.log("Seed complete:", { admin: admin.email, customer: customer.email });
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
