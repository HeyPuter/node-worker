"use strict";

class ReplHistory {
	constructor(rl, options = {}) {
		this.rl = rl;
		this.history = Array.isArray(options.history) ? [...options.history] : [];
		this.size = Number.isInteger(options.size) ? options.size : 30;
		this.removeHistoryDuplicates = !!options.removeHistoryDuplicates;
		this.index = -1;
		this.isFlushing = false;
	}

	initialize(onLoaded) {
		if (typeof onLoaded === "function") {
			queueMicrotask(() => onLoaded());
		}
	}

	addHistory() {
		const line = this.rl.line;
		if (!line) {
			this.index = -1;
			return line;
		}

		if (this.removeHistoryDuplicates) {
			this.history = this.history.filter((entry) => entry !== line);
		}
		this.history.unshift(line);
		if (this.history.length > this.size) {
			this.history.length = this.size;
		}
		this.index = -1;
		return line;
	}

	canNavigateToPrevious() {
		return this.index + 1 < this.history.length;
	}

	canNavigateToNext() {
		return this.index >= 0;
	}

	navigateToPrevious(substring) {
		const nextIndex = this.findPreviousIndex(this.index + 1, substring);
		if (nextIndex === -1) {
			return this.rl.line;
		}
		this.index = nextIndex;
		return this.history[this.index] || "";
	}

	navigateToNext(substring) {
		if (this.index <= 0) {
			this.index = -1;
			return "";
		}
		const nextIndex = this.findNextIndex(this.index - 1, substring);
		if (nextIndex === -1) {
			this.index = -1;
			return "";
		}
		this.index = nextIndex;
		return this.history[this.index] || "";
	}

	findPreviousIndex(start, substring) {
		for (let i = start; i < this.history.length; i++) {
			if (!substring || this.history[i].startsWith(substring)) {
				return i;
			}
		}
		return -1;
	}

	findNextIndex(start, substring) {
		for (let i = start; i >= 0; i--) {
			if (!substring || this.history[i].startsWith(substring)) {
				return i;
			}
		}
		return -1;
	}
}

module.exports = {
	ReplHistory,
};
