import { parseConfig } from "./config.js";
import { connect } from "./db/client.js";
import { buildApp } from "./http.js";

const config = parseConfig(process.env);
const db = connect(config);
const app = await buildApp(config, db);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await app.close();
  } finally {
    await db.end({ timeout: 5 });
  }
};
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch {
  console.error("Masterland API failed to start");
  await stop();
  process.exitCode = 1;
}
