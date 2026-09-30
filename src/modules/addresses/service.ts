import type { Address, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { checkServiceable } from "../shipping/methods";
import { createAddressSchema, type AddressInput } from "./schemas";
import type { z } from "zod";
import type { updateAddressSchema } from "./schemas";

type Client = PrismaClient | Prisma.TransactionClient;
type AddressUpdate = z.infer<typeof updateAddressSchema>;

const MAX_ADDRESSES = 20;

export function serializeAddress(a: Address) {
  return {
    id: a.id,
    label: a.label,
    fullName: a.fullName,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    landmark: a.landmark,
    city: a.city,
    state: a.state,
    postalCode: a.postalCode,
    country: a.country,
    isDefault: a.isDefault,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export async function listAddresses(userId: string) {
  const rows = await prisma.address.findMany({ where: { userId }, orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }] });
  return rows.map(serializeAddress);
}

/** Ownership check — another user's address reads as 404, never 403. */
export async function getOwnedAddress(userId: string, addressId: string, client: Client = prisma): Promise<Address> {
  const address = await client.address.findFirst({ where: { id: addressId, userId } });
  if (!address) throw ApiError.notFound("Address not found");
  return address;
}

async function promoteNewestAsDefault(tx: Prisma.TransactionClient, userId: string) {
  const next = await tx.address.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
  if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
}

export async function createAddress(userId: string, input: AddressInput) {
  const created = await prisma.$transaction(async (tx) => {
    const count = await tx.address.count({ where: { userId } });
    if (count >= MAX_ADDRESSES) throw ApiError.conflict(`You can save up to ${MAX_ADDRESSES} addresses`);
    // The first address is always the default.
    const makeDefault = input.isDefault === true || count === 0;
    if (makeDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
    const { isDefault: _ignored, ...fields } = input;
    return tx.address.create({ data: { ...fields, userId, isDefault: makeDefault } });
  });
  return serializeAddress(created);
}

export async function updateAddress(userId: string, addressId: string, input: AddressUpdate) {
  const updated = await prisma.$transaction(async (tx) => {
    const existing = await getOwnedAddress(userId, addressId, tx);
    const { isDefault, ...fields } = input;
    if (isDefault === true && !existing.isDefault) {
      await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
    }
    // Unsetting the default only makes sense by picking another one; the
    // flag is ignored here so the user never ends up with none.
    return tx.address.update({
      where: { id: existing.id },
      data: { ...fields, ...(isDefault === true ? { isDefault: true } : {}) },
    });
  });
  return serializeAddress(updated);
}

export async function setDefaultAddress(userId: string, addressId: string) {
  return updateAddress(userId, addressId, { isDefault: true });
}

/** Past orders keep their own address snapshot (Order.addressId is SET NULL). */
export async function deleteAddress(userId: string, addressId: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await getOwnedAddress(userId, addressId, tx);
    await tx.address.delete({ where: { id: existing.id } });
    if (existing.isDefault) await promoteNewestAsDefault(tx, userId);
  });
}

/**
 * A saved address is re-validated at checkout with today's rules (it may
 * predate them, or the rules may have tightened) plus serviceability.
 */
export function assertAddressDeliverable(address: Address) {
  const parsed = createAddressSchema.safeParse({
    label: address.label,
    fullName: address.fullName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2 ?? undefined,
    landmark: address.landmark ?? undefined,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
  });
  if (!parsed.success) {
    throw ApiError.unprocessable(
      "This address is incomplete or invalid — please edit it before placing your order",
      { addressId: address.id, fieldErrors: parsed.error.flatten().fieldErrors },
      "address_invalid"
    );
  }
  const serviceable = checkServiceable(address);
  if (!serviceable.ok) {
    throw ApiError.unprocessable(serviceable.reason, { addressId: address.id }, "delivery_unavailable");
  }
}

/** Columns copied onto the Order so fulfilment never depends on the address row. */
export function addressSnapshot(address: Address, email: string) {
  return {
    addressId: address.id,
    deliveryName: address.fullName,
    deliveryEmail: email,
    deliveryPhone: address.phone,
    deliveryAddressLine1: address.line1,
    deliveryAddressLine2: [address.line2, address.landmark ? `Landmark: ${address.landmark}` : null].filter(Boolean).join(", ") || null,
    city: address.city,
    deliveryState: address.state,
    deliveryPostalCode: address.postalCode,
    deliveryCountry: address.country,
  };
}
