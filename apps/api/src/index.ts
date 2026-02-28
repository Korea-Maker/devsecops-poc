import { buildApp } from "./app.js";
import { startScanWorker, stopScanWorkerAndDrain } from "./scanner/queue.js";

const app = buildApp();

const port = Number(process.env.API_PORT) || 3001;
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log(`[api] 종료 신호 수신: ${signal}`);
  await stopScanWorkerAndDrain();

  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  try {
    // onReady 훅(스토어 hydration 포함)이 끝난 뒤 워커/리스너를 기동한다.
    await app.ready();

    const address = await app.listen({ port, host: "0.0.0.0" });
    startScanWorker();
    console.log(`🚀 API 서버 실행 중: ${address}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void bootstrap();

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
