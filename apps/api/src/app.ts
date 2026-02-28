import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { scanRoutes } from "./routes/scans.js";
import { githubRoutes } from "./routes/github.js";
import { authRoutes } from "./routes/auth.js";
import { tenantRoutes } from "./routes/tenants.js";
import {
  initializeDataBackend,
  shutdownDataBackend,
} from "./storage/backend.js";
import { hydrateScanStore } from "./scanner/store.js";
import { hydrateQueueState } from "./scanner/queue.js";
import { hydrateOrganizationStore } from "./tenants/store.js";
import { hydrateTenantAuditLogs } from "./tenants/audit-log.js";
import { validateTenantAuthConfiguration } from "./tenants/auth.js";

export function buildApp() {
  const app = Fastify({
    logger: false,
  });

  app.addHook("onReady", async () => {
    const tenantAuthValidation = validateTenantAuthConfiguration();
    if (!tenantAuthValidation.ok) {
      const startupError = new Error(tenantAuthValidation.error) as Error & {
        statusCode?: number;
        code?: string;
      };
      startupError.statusCode = tenantAuthValidation.statusCode;
      startupError.code = tenantAuthValidation.code;
      throw startupError;
    }

    const initResult = await initializeDataBackend({ logger: app.log });

    hydrateScanStore(initResult.persistedState.scans);
    hydrateQueueState(initResult.persistedState.queue);
    hydrateOrganizationStore({
      organizations: initResult.persistedState.organizations,
      memberships: initResult.persistedState.memberships,
      inviteTokens: initResult.persistedState.inviteTokens,
    });
    hydrateTenantAuditLogs(initResult.persistedState.tenantAuditLogs);
  });

  app.addHook("onClose", async () => {
    await shutdownDataBackend();
  });

  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(scanRoutes);
  app.register(githubRoutes);
  app.register(tenantRoutes);

  return app;
}
