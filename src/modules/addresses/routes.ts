import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { INDIA_STATES } from "../../lib/indiaStates";
import { createAddressSchema, updateAddressSchema } from "./schemas";
import * as addressService from "./service";

export const addressesRouter = Router();

// Public reference data for the address form's state picker.
addressesRouter.get("/regions", (_req, res) => {
  res.json({ countries: [{ code: "IN", name: "India", states: INDIA_STATES }] });
});

addressesRouter.use(requireAuth);

addressesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ items: await addressService.listAddresses(req.auth!.userId) });
  })
);

addressesRouter.post(
  "/",
  validateBody(createAddressSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await addressService.createAddress(req.auth!.userId, req.body));
  })
);

addressesRouter.patch(
  "/:id",
  validateBody(updateAddressSchema),
  asyncHandler(async (req, res) => {
    res.json(await addressService.updateAddress(req.auth!.userId, req.params.id, req.body));
  })
);

addressesRouter.post(
  "/:id/default",
  asyncHandler(async (req, res) => {
    res.json(await addressService.setDefaultAddress(req.auth!.userId, req.params.id));
  })
);

addressesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await addressService.deleteAddress(req.auth!.userId, req.params.id);
    res.status(204).end();
  })
);
