self.onmessage = async (ev) => {
	const { type, token, code, cwd } = ev.data;

	if (type !== "exec") return;

	const { runCode, setPuterToken, setPuterCWD } = await import("./index.js");

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
		const result = await runCode(code, true);
		const text =
			result !== undefined
				? typeof result === "string"
					? result
					: JSON.stringify(result, null, 2)
				: undefined;
		self.postMessage({ type: "result", text });
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
