/**
 * Create (or upgrade) the SQLite database and report where it is.
 * `MeetingStore` applies the schema on open, so this is that, plus output.
 */
import { loadConfig } from "../src/config.js";
import { MeetingStore } from "../src/store/store.js";

const config = loadConfig();
const store = new MeetingStore(config.databasePath);
const tables = store.db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all() as { name: string }[];
store.close();

console.log(`database: ${config.databasePath}`);
console.log(`tables:   ${tables.map((table) => table.name).join(", ")}`);
