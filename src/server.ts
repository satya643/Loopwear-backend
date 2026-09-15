import { createApp } from "./app";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";

async function start() {
  try {
    // Prisma connects lazily on the first query by default, so without this
    // the server would report "listening" and look healthy even with a
    // completely unreachable database — this forces that check up front.
    await prisma.$connect();
    // eslint-disable-next-line no-console
    console.log("Database connected");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Database connection failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const app = createApp();
  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`LoopWear backend listening on http://localhost:${env.port}`);
  });
}

start();
