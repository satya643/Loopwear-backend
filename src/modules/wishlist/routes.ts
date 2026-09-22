import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { presentPricing } from "../../lib/pricing";

export const wishlistRouter = Router();
wishlistRouter.use(requireAuth);

wishlistRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const items = await prisma.wishlistItem.findMany({
      where: { userId: req.auth!.userId },
      // Wishlist doesn't capture a color choice (see ProductVariant) — the
      // first variant stands in as the product's representative image.
      include: { product: { include: { variants: { take: 1, orderBy: { createdAt: "asc" } } } } },
      orderBy: { addedAt: "desc" },
    });
    res.json({
      items: items.map((i) => ({
        productId: i.productId,
        addedAt: i.addedAt,
        product: {
          id: i.product.id,
          name: i.product.name,
          brand: i.product.brand,
          imageUrls:
            Object.keys(i.product.variants[0]?.imageUrls ?? {}).length > 0
              ? (i.product.variants[0]!.imageUrls as Record<string, string>)
              : i.product.coverImageUrl
                ? { front: i.product.coverImageUrl }
                : {},
          pricing: presentPricing(
            { rentPricePaise: i.product.rentPricePaise, buyPricePaise: i.product.buyPricePaise },
            { currency: req.currency, fxRate: req.fxRate }
          ),
        },
      })),
    });
  })
);

wishlistRouter.put(
  "/:productId",
  asyncHandler(async (req, res) => {
    const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
    if (!product) throw ApiError.notFound("Product not found");

    await prisma.wishlistItem.upsert({
      where: { userId_productId: { userId: req.auth!.userId, productId: req.params.productId } },
      update: {},
      create: { userId: req.auth!.userId, productId: req.params.productId },
    });
    res.status(204).end();
  })
);

wishlistRouter.delete(
  "/:productId",
  asyncHandler(async (req, res) => {
    await prisma.wishlistItem
      .delete({
        where: { userId_productId: { userId: req.auth!.userId, productId: req.params.productId } },
      })
      .catch(() => {});
    res.status(204).end();
  })
);
