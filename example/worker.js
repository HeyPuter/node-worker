self.onmessage = async (ev) => {
	const { type, token, code } = ev.data;

	if (type !== "exec") return;

	const { default: lib } = await import("./index.js");
	const { fs, buffer, path, events, stream, util, zlib, setPuterAuth } = lib;

	setPuterAuth(token);

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
		// build the runner function:
		// (async ({ fs, buffer, path, events, stream, util, zlib }) => {
		//   ...user code...
		// })({ fs, buffer, path, events, stream, util, zlib })
		const asyncBody = `return (async ({ fs, buffer, path, events, stream, util, zlib }) => {\n${code}\n})({ fs, buffer, path, events, stream, util, zlib })`;
		const fn = new Function(
			"fs",
			"buffer",
			"path",
			"events",
			"stream",
			"util",
			"zlib",
			asyncBody
		);
		const result = await fn(fs, buffer, path, events, stream, util, zlib);
		const text =
			result !== undefined
				? typeof result === "string"
					? result
					: JSON.stringify(result, null, 2)
				: undefined;
		self.postMessage({ type: "result", text });
	} catch (e) {
		self.postMessage({
			type: "runtime-error",
			message: e.message,
			stack: e.stack,
		});
	} finally {
		// restore console
		Object.assign(console, origConsole);
	}
};
