import jwt from "jsonwebtoken";
import { env } from "../config/env";
import type { Role } from "@prisma/client";

export interface SessionTokenPayload {
  sub: string; // user id
  sessionId: string;
  role: Role;
}

export function signSessionToken(payload: SessionTokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: `${env.jwtTtlDays}d` });
}

export function verifySessionToken(token: string): SessionTokenPayload {
  return jwt.verify(token, env.jwtSecret) as SessionTokenPayload;
}
