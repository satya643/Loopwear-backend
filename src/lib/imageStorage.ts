import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { cloudinary, isCloudinaryConfigured } from "./cloudinary";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

function uploadToCloudinary(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder: "loopwear/products", resource_type: "image" }, (err, result) => {
      if (err || !result) return reject(err ?? new Error("Cloudinary upload failed"));
      resolve(result.secure_url);
    });
    stream.end(buffer);
  });
}

// Saved straight onto this server's own disk and served back out via
// express.static (see app.ts: app.use("/uploads", ...)). Only survives on
// this machine/container — fine for local dev, wrong for any host with an
// ephemeral or multi-instance filesystem — so this is a fallback, not the
// production storage strategy.
async function saveLocally(buffer: Buffer, mimetype: string): Promise<string> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const ext = EXT_BY_MIME[mimetype] ?? "jpg";
  const filename = `${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), buffer);
  const base = (process.env.APP_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
  return `${base}/uploads/${filename}`;
}

/**
 * Cloudinary when CLOUDINARY_* env vars are set (works the same on
 * localhost and in production) — falls back to saving the file onto this
 * server's own disk otherwise, or if Cloudinary itself errors (bad
 * credentials, network, quota), so an admin can still upload variant
 * images without Cloudinary being configured or working.
 */
export async function storeImage(buffer: Buffer, mimetype: string): Promise<string> {
  if (isCloudinaryConfigured()) {
    try {
      return await uploadToCloudinary(buffer);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Cloudinary upload failed, falling back to local disk storage —", err);
    }
  }
  return saveLocally(buffer, mimetype);
}
