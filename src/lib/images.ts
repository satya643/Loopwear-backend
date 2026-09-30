/**
 * Picks the photo to show for a product line: the colour's own model/front
 * shot first, falling back to the product's admin-uploaded cover image.
 * `imageUrls` is a Json column (Partial<Record<view, url>>), so it's read
 * defensively.
 */
export function pickImageUrl(imageUrls: unknown, fallback: string | null | undefined): string | null {
  if (imageUrls && typeof imageUrls === "object") {
    const urls = imageUrls as Record<string, unknown>;
    for (const view of ["model", "front", "detail", "back", "fabric"]) {
      if (typeof urls[view] === "string" && urls[view]) return urls[view] as string;
    }
  }
  return fallback ?? null;
}
