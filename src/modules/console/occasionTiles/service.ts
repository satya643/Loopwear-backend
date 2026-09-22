import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";
import { OCCASION_LABELS } from "../../../lib/enumLabels";

interface OccasionTileInput {
  imageUrl: string;
  blurb: string;
}

function assertKnownOccasion(occasion: string) {
  if (!(occasion in OCCASION_LABELS)) throw ApiError.badRequest(`Unknown occasion "${occasion}"`);
}

// Always returns every occasion, even ones with no tile set yet (imageUrl/
// blurb null) — the admin UI renders one slot per occasion regardless of
// whether it's been filled in.
export async function listOccasionTiles() {
  const tiles = await prisma.occasionTile.findMany();
  const byOccasion = new Map(tiles.map((t) => [t.occasion as string, t]));

  return Object.entries(OCCASION_LABELS).map(([code, label]) => {
    const tile = byOccasion.get(code);
    return {
      occasion: code,
      label,
      imageUrl: tile?.imageUrl ?? null,
      blurb: tile?.blurb ?? null,
      updatedAt: tile?.updatedAt ?? null,
    };
  });
}

export async function upsertOccasionTile(occasion: string, input: OccasionTileInput) {
  assertKnownOccasion(occasion);
  return prisma.occasionTile.upsert({
    where: { occasion: occasion as never },
    create: { occasion: occasion as never, ...input },
    update: input,
  });
}

export async function deleteOccasionTile(occasion: string) {
  assertKnownOccasion(occasion);
  await prisma.occasionTile.deleteMany({ where: { occasion: occasion as never } });
}
