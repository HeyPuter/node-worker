// Parsing an `fs.open` flags string.
//
// Shared because both sides need it now: the worker validates what a program passed, and the
// host actually opens the file and has to know whether to create, truncate or append. One copy,
// so `"a+"` cannot mean two different things depending on which side is asking.

import { fsError } from "./errno";

export type OpenFlags = {
	flag: string;
	read: boolean;
	write: boolean;
	append: boolean;
	create: boolean;
	truncateOnOpen: boolean;
	exclusive: boolean;
};

// Parses an fs open() flags argument ("r", "w+", "ax", ...) into the booleans
// the handle implementations care about. Numeric flags aren't supported because
// puterfs has no real file descriptors to map them onto.
export function parseOpenFlags(flags: string | number | undefined): OpenFlags {
	if (flags === undefined) flags = "r";

	if (typeof flags === "number") {
		throw fsError("EINVAL", {
			syscall: "open",
			message: "numeric open flags are not supported",
		});
	}

	const aliases: Record<string, string> = {
		rs: "r",
		"rs+": "r+",
		as: "a",
		"as+": "a+",
	};

	const normalized = aliases[flags] ?? flags;

	const table: Record<string, OpenFlags> = {
		r: {
			flag: "r",
			read: true,
			write: false,
			append: false,
			create: false,
			truncateOnOpen: false,
			exclusive: false,
		},
		"r+": {
			flag: "r+",
			read: true,
			write: true,
			append: false,
			create: false,
			truncateOnOpen: false,
			exclusive: false,
		},
		w: {
			flag: "w",
			read: false,
			write: true,
			append: false,
			create: true,
			truncateOnOpen: true,
			exclusive: false,
		},
		"w+": {
			flag: "w+",
			read: true,
			write: true,
			append: false,
			create: true,
			truncateOnOpen: true,
			exclusive: false,
		},
		wx: {
			flag: "wx",
			read: false,
			write: true,
			append: false,
			create: true,
			truncateOnOpen: true,
			exclusive: true,
		},
		"wx+": {
			flag: "wx+",
			read: true,
			write: true,
			append: false,
			create: true,
			truncateOnOpen: true,
			exclusive: true,
		},
		a: {
			flag: "a",
			read: false,
			write: true,
			append: true,
			create: true,
			truncateOnOpen: false,
			exclusive: false,
		},
		"a+": {
			flag: "a+",
			read: true,
			write: true,
			append: true,
			create: true,
			truncateOnOpen: false,
			exclusive: false,
		},
		ax: {
			flag: "ax",
			read: false,
			write: true,
			append: true,
			create: true,
			truncateOnOpen: false,
			exclusive: true,
		},
		"ax+": {
			flag: "ax+",
			read: true,
			write: true,
			append: true,
			create: true,
			truncateOnOpen: false,
			exclusive: true,
		},
	};

	const parsed = table[normalized];
	if (!parsed)
		throw fsError("EINVAL", { syscall: "open", message: "invalid flags" });
	return parsed;
}
