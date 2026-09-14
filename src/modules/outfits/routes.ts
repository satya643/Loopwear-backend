import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { presentPricing } from "../../lib/pricing";
import { OCCASION_LABELS, occasionCodeFromLabel } from "../../lib/enumLabels";

export const outfitsRouter = Router();

function serializeOutfit(outfit: any, ctx: { currency: string; fxRate: number }) {
  return {
    id: outfit.id,
    name: outfit.name,
    occasion: OCCASION_LABELS[outfit.occasion] ?? outfit.occasion,
    pricing: presentPricing(
      {
        lookRentPricePaise: outfit.lookRentPricePaise,
        lookBuyPricePaise: outfit.lookBuyPricePaise,
      },
      ctx
    ),
    lookRentDays: outfit.lookRentDays,
    products: outfit.outfitProducts?.map((op: any) => op.product) ?? undefined,
  };
}

outfitsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const occasionParam = req.query.occasion as string | undefined;
    const where = occasionParam
      ? { occasion: (occasionCodeFromLabel(occasionParam) ?? occasionParam) as never }
      : {};
    const outfits = await prisma.outfit.findMany({ where });
    res.json({ items: outfits.map((o) => serializeOutfit(o, { currency: req.currency, fxRate: req.fxRate })) });
  })
);

outfitsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const outfit = await prisma.outfit.findUnique({
      where: { id: req.params.id },
      include: { outfitProducts: { include: { product: true }, orderBy: { position: "asc" } } },
    });
    if (!outfit) throw ApiError.notFound("Outfit not found");
    res.json(serializeOutfit(outfit, { currency: req.currency, fxRate: req.fxRate }));
  })
);
