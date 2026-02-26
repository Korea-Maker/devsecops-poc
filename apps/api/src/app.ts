import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { scanRoutes } from "./routes/scans.js";

export function buildApp() {
  const app = Fastify({
    logger: false,
  });

  app.register(healthRoutes);
  app.register(scanRoutes);

  return app;
}
