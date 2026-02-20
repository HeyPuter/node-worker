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
const cliPWD = puter.args?.env?.PWD;
const cliArgs = puter.args?.command_line?.args;
const isCliMode = typeof cliPWD === "string" && Array.isArray(cliArgs);
const shell = isCliMode ? puter.ui.parentApp() : null;
const textEncoder = new TextEncoder();

const KV_CWD_KEY = "working-directory";

// ── CWD persistence (via puter.kv) ──
async function loadCWD() {
	try {
		const val = await puter.kv.get(KV_CWD_KEY);
		if (val) return val;
	} catch {}
	return "/";
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
	user = await puter.auth.getUser();
	token = puter.authToken;
	userInfo.textContent = user.username;
	appendOutput(`authenticated as ${user.username}`, "log-system");
} catch (e) {
	userInfo.textContent = "auth failed";
	appendOutput(`authentication failed: ${e.message}`, "log-error");
}
// ── Worker management ──
function spawnWorker() {
	if (worker) {
		worker.terminate();
	}
	worker = new Worker("./worker.js", {
		type: "module",
		name: "puter-node-runner",
	});

	worker.onmessage = (e) => {
		const msg = e.data;
		if (msg.type === "log") {
			appendOutput(msg.text, "log-info");
		} else if (msg.type === "error") {
			appendOutput(msg.text, "log-error");
		} else if (msg.type === "warn") {
			appendOutput(msg.text, "log-warn");
		} else if (msg.type === "result") {
			if (msg.text !== undefined) {
				appendOutput(`=> ${msg.text}`, "log-success");
			}
			setRunning(false);
			appendOutput("execution finished", "log-system");
		} else if (msg.type === "runtime-error") {
			function err(e, prefix) {
				appendOutput(`${prefix}: ${e.message || e}`, "log-error");
				if (e.stack) appendOutput(e.stack, "log-error");

				if (e.cause) err(e.cause, "Caused by");
			}
			err(msg.error, "Runtime Error");
			setRunning(false);
		} else if (msg.type === "ready") {
			appendOutput("worker ready", "log-system");
		}
	};

	worker.onerror = (e) => {
		appendOutput(`Worker error: ${e.message}`, "log-error");
		setRunning(false);
	};

	return worker;
}

function setRunning(running) {
	btnRun.disabled = running;
	btnStop.disabled = !running;
	runStatus.textContent = running ? "running..." : "ready";
}

function runInWorker(code, cwd, persistCWD = true) {
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

	const w = spawnWorker();
	w.postMessage({ type: "exec", token, code, cwd });
	if (persistCWD) {
		saveCWD(cwd);
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
	if (worker) {
		worker.terminate();
		worker = null;
		appendOutput("execution stopped", "log-warn");
		setRunning(false);
	}
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
