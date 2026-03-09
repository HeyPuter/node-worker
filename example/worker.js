self.onmessage = async (ev) => {
	const { type, token, code, cwd } = ev.data;
	const path = cwd + "/__puter_node.js";

	if (type !== "exec") return;

	const {
		esmImport,
		registerVirtualSource,
		deregisterVirtualSource,
		setPuterToken,
		setPuterCWD,
	} = await import("./index.js");

	setPuterToken(token);
	setPuterCWD(cwd || "/");

	function formatArgs(args) {
		return args
			.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
			.join(" ");
	}

	// intercept console in the worker so output goes back to main thread
	const origConsole = {
		log: console.log,
		error: console.error,
		warn: console.warn,
		info: console.info,
	};
	console.log = (...args) => {
		origConsole.log(...args);
		self.postMessage({ type: "log", text: formatArgs(args) });
	};
	console.error = (...args) => {
		origConsole.error(...args);
		self.postMessage({ type: "error", text: formatArgs(args) });
	};
	console.warn = (...args) => {
		origConsole.warn(...args);
		self.postMessage({ type: "warn", text: formatArgs(args) });
	};
	console.info = (...args) => {
		origConsole.info(...args);
		self.postMessage({ type: "log", text: formatArgs(args) });
	};

	try {
		registerVirtualSource(path, code);
		try {
			await esmImport(path);
			self.postMessage({ type: "result" });
		} finally {
			deregisterVirtualSource(path);
		}
	} catch (e) {
		function err(e) {
			if (!e.message) return e;

			return {
				message: e.message,
				stack: e.stack,
				...(e.cause ? { cause: err(e.cause) } : {}),
			};
		}
		self.postMessage({
			type: "runtime-error",
			error: err(e),
		});
	} finally {
		// restore console
		Object.assign(console, origConsole);
	}
};
