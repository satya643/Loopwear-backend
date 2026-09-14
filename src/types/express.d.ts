import type { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        sessionId: string;
        role: Role;
      };
      currency: string;
      fxRate: number;
    }
  }
}

export {};
