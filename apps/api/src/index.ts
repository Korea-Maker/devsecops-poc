import { buildApp } from "./app.js";

const app = buildApp();

const port = Number(process.env.API_PORT) || 3001;

app.listen({ port, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 API 서버 실행 중: ${address}`);
});
