// ── DOM refs ──
const codeEditor = document.getElementById("code-editor");
const outputContent = document.getElementById("output-content");
const btnRun = document.getElementById("btn-run");
const btnStop = document.getElementById("btn-stop");
const btnClear = document.getElementById("btn-clear");
const btnClearOutput = document.getElementById("btn-clear-output");
const runStatus = document.getElementById("run-status");
const userInfo = document.getElementById("user-info");
const btnRequestPerms = document.getElementById("btn-request-perms");
const resizeHandle = document.getElementById("resize-handle");
const outputPanel = document.getElementById("output-panel");

// ── State ──
let worker = null;
let token = null;
let user = null;

// ── Perm definitions ──
// Maps checkbox id -> { method: SDK convenience method name }
const PERM_MAP = {
	"perm-read-desktop": { method: "requestReadDesktop" },
	"perm-write-desktop": { method: "requestWriteDesktop" },
	"perm-read-documents": { method: "requestReadDocuments" },
	"perm-write-documents": { method: "requestWriteDocuments" },
	"perm-read-pictures": { method: "requestReadPictures" },
	"perm-write-pictures": { method: "requestWritePictures" },
	"perm-read-videos": { method: "requestReadVideos" },
	"perm-write-videos": { method: "requestWriteVideos" },
	"perm-email": { method: "requestEmail" },
	"perm-read-apps": { method: "requestReadApps" },
	"perm-manage-apps": { method: "requestManageApps" },
	"perm-read-subdomains": { method: "requestReadSubdomains" },
	"perm-manage-subdomains": { method: "requestManageSubdomains" },
};

const KV_PERMS_KEY = "perm-states";

// ── Output helpers ──
function appendOutput(text, cls = "log-info") {
	const div = document.createElement("div");
	div.className = `log-line ${cls}`;
	div.textContent = text;
	outputContent.appendChild(div);
	outputContent.scrollTop = outputContent.scrollHeight;
}

function clearOutput() {
	outputContent.innerHTML = "";
}

// ── Perm status persistence (via puter.kv) ──
async function loadPermStates() {
	try {
		const val = await puter.kv.get(KV_PERMS_KEY);
		if (val) return JSON.parse(val);
	} catch {}
	return {};
}

async function savePermState(id, status) {
	const states = await loadPermStates();
	states[id] = status;
	await puter.kv.set(KV_PERMS_KEY, JSON.stringify(states));
}

function setPermStatus(checkbox, status) {
	const item = checkbox.closest(".perm-item");
	let badge = item.querySelector(".perm-status");
	if (!badge) {
		badge = document.createElement("span");
		badge.className = "perm-status";
		item.appendChild(badge);
	}
	badge.textContent = status;
	badge.className = `perm-status ${status}`;
}

async function restorePermStatuses() {
	const states = await loadPermStates();
	for (const [id, status] of Object.entries(states)) {
		const cb = document.getElementById(id);
		if (cb) {
			setPermStatus(cb, status);
		}
	}
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

// Restore cached perm statuses on load
await restorePermStatuses();

// ── Permissions ──
btnRequestPerms.addEventListener("click", async () => {
	const checked = Object.entries(PERM_MAP).filter(([id]) => {
		return document.getElementById(id).checked;
	});

	if (checked.length === 0) {
		appendOutput("no permissions selected", "log-warn");
		return;
	}

	btnRequestPerms.disabled = true;
	btnRequestPerms.textContent = "requesting...";

	for (const [id, { method }] of checked) {
		const cb = document.getElementById(id);
		const label = cb.nextElementSibling.textContent;
		try {
			setPermStatus(cb, "pending");
			const result = await puter.perms[method]();
			if (result) {
				setPermStatus(cb, "granted");
				await savePermState(id, "granted");
				appendOutput(`permission granted: ${label}`, "log-success");
			} else {
				setPermStatus(cb, "denied");
				await savePermState(id, "denied");
				appendOutput(`permission denied: ${label}`, "log-warn");
			}
		} catch (e) {
			setPermStatus(cb, "denied");
			await savePermState(id, "denied");
			appendOutput(`permission error (${label}): ${e.message}`, "log-error");
		}
	}

	btnRequestPerms.disabled = false;
	btnRequestPerms.textContent = "Request Selected";
});

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
			appendOutput(`Runtime Error: ${msg.message}`, "log-error");
			if (msg.stack) appendOutput(msg.stack, "log-error");
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

// ── Run code ──
btnRun.addEventListener("click", () => {
	if (!token) {
		appendOutput("not authenticated, cannot run", "log-error");
		return;
	}
	const code = codeEditor.value;
	if (!code.trim()) {
		appendOutput("no code to run", "log-warn");
		return;
	}

	setRunning(true);
	appendOutput("--- run ---", "log-system");

	const w = spawnWorker();
	w.postMessage({ type: "exec", token, code });
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
