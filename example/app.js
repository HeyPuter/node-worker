import { NodeWorker } from "./index.js";

// ── DOM refs ──
const codeEditor = document.getElementById("code-editor");
const outputContent = document.getElementById("output-content");
const btnRun = document.getElementById("btn-run");
const btnStop = document.getElementById("btn-stop");
const btnClear = document.getElementById("btn-clear");
const btnClearOutput = document.getElementById("btn-clear-output");
const runStatus = document.getElementById("run-status");
const userInfo = document.getElementById("user-info");
const resizeHandle = document.getElementById("resize-handle");
const outputPanel = document.getElementById("output-panel");
const cwdInput = document.getElementById("cwd-input");

// ── State ──
let worker = null;
let token = null;
let user = null;
let workerToken = null;
const cliPWD = puter.args?.env?.PWD;
const cliArgs = puter.args?.command_line?.args;
const isCliMode = typeof cliPWD === "string" && Array.isArray(cliArgs);
const shell = isCliMode ? puter.ui.parentApp() : null;
const textEncoder = new TextEncoder();

const KV_CWD_KEY = "working-directory";
const TOKEN_OVERRIDE_STORAGE_KEY = "node-worker-token-override";

function getTokenOverride() {
	try {
		const tokenOverride = localStorage.getItem(TOKEN_OVERRIDE_STORAGE_KEY);
		if (typeof tokenOverride === "string" && tokenOverride.length > 0) {
			return tokenOverride;
		}
	} catch {}

	return null;
}

// ── CWD persistence (via puter.kv) ──
async function loadCWD() {
	try {
		const val = await puter.kv.get(KV_CWD_KEY);
		if (val) return val;
	} catch {}
	return "/" + user.username + "/";
}

async function saveCWD(cwd) {
	await puter.kv.set(KV_CWD_KEY, cwd);
}

// ── Output helpers ──
function appendOutput(text, cls = "log-info") {
	const div = document.createElement("div");
	div.className = `log-line ${cls}`;
	div.textContent = text;
	outputContent.appendChild(div);
	outputContent.scrollTop = outputContent.scrollHeight;
	if (shell) {
		shell.postMessage({
			$: "stdout",
			data: textEncoder.encode(`${text}\n`),
		});
	}
}

function clearOutput() {
	outputContent.innerHTML = "";
}

// ── Auth ──
try {
	const tokenOverride = getTokenOverride();
	if (tokenOverride) {
		if (typeof puter.setAuthToken === "function") {
			puter.setAuthToken(tokenOverride);
		} else {
			puter.authToken = tokenOverride;
		}
	}

	user = await puter.auth.getUser();
	token = puter.authToken;
	userInfo.textContent = user.username;
	appendOutput(`authenticated as ${user.username}`, "log-system");
	if (tokenOverride) {
		appendOutput("token override active from localStorage", "log-system");
	}
} catch (e) {
	userInfo.textContent = "auth failed";
	appendOutput(`authentication failed: ${e.message}`, "log-error");
}
// ── Worker management ──
function terminateNodeWorker() {
	if (!worker) return;

	worker.terminate();
	worker = null;
	workerToken = null;
}

function normalizeCwd(cwd) {
	if (!cwd) return "/";
	if (cwd === "/") return "/";
	return cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
}

async function getNodeWorker(cwd, effectiveToken) {
	if (!worker || workerToken !== effectiveToken) {
		terminateNodeWorker();
		worker = new NodeWorker("./worker.js", effectiveToken, cwd);
		workerToken = effectiveToken;
		await worker.ready;
		appendOutput("worker ready", "log-system");
	} else {
		await worker.setCwd(cwd);
	}

	return worker;
}

function setRunning(running) {
	btnRun.disabled = running;
	btnStop.disabled = !running;
	runStatus.textContent = running ? "running..." : "ready";
}

async function runInWorker(code, cwd, persistCWD = true) {
	if (!token) {
		appendOutput("not authenticated, cannot run", "log-error");
		return;
	}
	if (!code.trim()) {
		appendOutput("no code to run", "log-warn");
		return;
	}

	setRunning(true);
	appendOutput("--- run ---", "log-system");
	const normalizedCwd = normalizeCwd(cwd);
	const modulePath = `${normalizedCwd}/__puter_node.js`;

	try {
		const nodeWorker = await getNodeWorker(normalizedCwd, token);
		await nodeWorker.registerVirtualModule(modulePath, code);

		try {
			await nodeWorker.import(modulePath);
			appendOutput("execution finished", "log-system");
		} finally {
			await nodeWorker.removeVirtualModule(modulePath);
		}

		if (persistCWD) {
			saveCWD(normalizedCwd);
		}
	} catch (e) {
		appendOutput(`Runtime Error: ${e?.message || e}`, "log-error");
		if (e?.stack) appendOutput(e.stack, "log-error");
	} finally {
		setRunning(false);
	}
}

function escapeForSingleQuotedJS(str) {
	return str.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

// ── Run code ──
btnRun.addEventListener("click", () => {
	const code = codeEditor.value;
	const cwd = cwdInput.value || "/";
	runInWorker(code, cwd);
});

// ── Stop ──
btnStop.addEventListener("click", () => {
	terminateNodeWorker();
	appendOutput("execution stopped", "log-warn");
	setRunning(false);
});

// ── Clear ──
btnClear.addEventListener("click", () => {
	codeEditor.value = "";
});
btnClearOutput.addEventListener("click", clearOutput);

// ── Tab key in editor ──
codeEditor.addEventListener("keydown", (e) => {
	if (e.key === "Tab") {
		e.preventDefault();
		const start = codeEditor.selectionStart;
		const end = codeEditor.selectionEnd;
		codeEditor.value =
			codeEditor.value.substring(0, start) +
			"\t" +
			codeEditor.value.substring(end);
		codeEditor.selectionStart = codeEditor.selectionEnd = start + 1;
	}
	// Ctrl/Cmd + Enter to run
	if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
		e.preventDefault();
		btnRun.click();
	}
});

// ── CWD initialization & save on change ──
if (isCliMode) {
	cwdInput.value = cliPWD;
} else {
	loadCWD().then((cwd) => {
		cwdInput.value = cwd;
	});
}
cwdInput.addEventListener("change", () => {
	saveCWD(cwdInput.value || "/");
});

if (isCliMode) {
	const fileToRun = cliArgs[0];
	if (typeof fileToRun === "string" && fileToRun.length > 0) {
		const code = `require('${escapeForSingleQuotedJS(fileToRun)}')`;
		codeEditor.value = code;
		runInWorker(code, cliPWD, false);
	} else {
		appendOutput("cli mode: missing file argument", "log-error");
	}
}

// ── Resize handle ──
let resizing = false;
resizeHandle.addEventListener("mousedown", (e) => {
	resizing = true;
	e.preventDefault();
});
document.addEventListener("mousemove", (e) => {
	if (!resizing) return;
	const rect = outputPanel.parentElement.getBoundingClientRect();
	const newHeight = rect.bottom - e.clientY;
	outputPanel.style.height =
		Math.max(60, Math.min(newHeight, rect.height - 100)) + "px";
});
document.addEventListener("mouseup", () => {
	resizing = false;
});
