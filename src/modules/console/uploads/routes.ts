import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { ApiError } from "../../../lib/errors";
import { storeImage } from "../../../lib/imageStorage";

export const consoleUploadsRouter = Router();
consoleUploadsRouter.use(requireAuth, requireRole("operator", "admin"));

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(ApiError.badRequest("Only image files are accepted"));
      return;
    }
    cb(null, true);
  },
});

// Mirrors POST /console/uploads — takes a single multipart image ("file")
// and hands back a hosted URL (Cloudinary, or this server's own disk if
// Cloudinary isn't configured/working — see lib/imageStorage.ts). This is a
// bare file -> URL exchange with no product/variant tied to it; the admin
// panel saves the returned url onto a variant's imageUrls afterward, the
// same way it already accepted any other hosted URL (see
// console/products/schemas.ts).
consoleUploadsRouter.post(
  "/",
  (req, res, next) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return next(ApiError.badRequest(`Image must be ${MAX_FILE_BYTES / (1024 * 1024)}MB or smaller`));
      }
      next(err);
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No file uploaded — send it as multipart field "file"');
    const url = await storeImage(req.file.buffer, req.file.mimetype);
    res.status(201).json({ url });
  })
);
