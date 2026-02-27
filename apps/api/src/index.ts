import { buildApp } from "./app.js";
import { startScanWorker, stopScanWorker } from "./scanner/queue.js";

const app = buildApp();

const port = Number(process.env.API_PORT) || 3001;
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log(`[api] 종료 신호 수신: ${signal}`);
  stopScanWorker();

  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

app.listen({ port, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  startScanWorker();
  console.log(`🚀 API 서버 실행 중: ${address}`);
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
