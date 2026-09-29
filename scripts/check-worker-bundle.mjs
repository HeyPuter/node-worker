import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const worker = fs.readFileSync(path.join(root, "dist/worker.js"), "utf8");
const config = fs.readFileSync(path.join(root, "rollup.config.js"), "utf8");
const forbidden = [
	"wisp/relay-token/create",
	"peer/generate-turn",
	"auth_token",
	"PUTER_TOKEN",
	"RELAY_TOKEN",
];
const failures = forbidden.filter((name) => worker.includes(name));
if (config.includes("dynamicRequireTargets"))
	failures.push("broad dynamicRequireTargets");
if (!config.includes("strictRequires: true"))
	failures.push("missing strict CommonJS wrappers");
if (failures.length) {
	console.error(
		`worker bundle contains credential paths or fragile CommonJS settings: ${failures.join(", ")}`
	);
	process.exitCode = 1;
} else console.log("worker bundle contains no credential acquisition paths");
