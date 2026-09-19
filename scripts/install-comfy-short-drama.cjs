// Register the local workbench provider without changing any project's chosen model.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const appRoot = path.resolve(__dirname, "..");
const requireApp = createRequire(path.join(appRoot, "package.json"));
const database = new (requireApp("better-sqlite3"))(path.join(appRoot, "data/db2.sqlite"), { fileMustExist: true });
database.pragma("busy_timeout = 5000");
const id = "comfyshortdrama";
const file = path.join(appRoot, "data/vendor", `${id}.ts`);
fs.copyFileSync(path.join(appRoot, "data/vendor/comfyshortdrama.ts"), file);
database.prepare("INSERT INTO o_vendorConfig (id, inputValues, models, enable) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enable = excluded.enable")
  .run(id, JSON.stringify({ baseUrl: "http://127.0.0.1:8188", inferenceSteps: "5" }), "[]", 1);
database.close();
console.log(`Registered: ${id}`);
