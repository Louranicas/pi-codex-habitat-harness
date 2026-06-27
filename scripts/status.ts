import { resolve } from "node:path";
import { harnessStatus } from "../extensions/status.js";

const cwd = resolve(process.argv[2] ?? "..");
const status = await harnessStatus(cwd);
console.log(JSON.stringify(status, null, 2));
