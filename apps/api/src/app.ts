import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { scanRoutes } from "./routes/scans.js";
import { githubRoutes } from "./routes/github.js";
import { tenantRoutes } from "./routes/tenants.js";

export function buildApp() {
  const app = Fastify({
    logger: false,
  });

  app.register(healthRoutes);
  app.register(scanRoutes);
  app.register(githubRoutes);
  app.register(tenantRoutes);

  return app;
}
