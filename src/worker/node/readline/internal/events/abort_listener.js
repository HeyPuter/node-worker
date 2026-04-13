"use strict";

const SymbolDispose = Symbol.dispose || Symbol.for("Symbol.dispose");

function addAbortListener(signal, listener) {
	signal.addEventListener("abort", listener, { once: true });
	const dispose = () => {
		signal.removeEventListener("abort", listener);
	};
	return {
		[SymbolDispose]: dispose,
	};
}

module.exports = {
	addAbortListener,
};
