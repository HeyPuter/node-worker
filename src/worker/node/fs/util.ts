import nodeBuffer from "../buffer";
import nodePath from "../path";
import { CWD } from "../../state";

let Buffer = nodeBuffer.Buffer;

type NodeFs = typeof import("node:fs");

// A stat result that satisfies both node's number (`Stats`) and bigint
// (`BigIntStats`) shapes. Our `Stats` class produces one or the other at
// runtime depending on the `bigint` flag; casting the construction to this
// intersection lets `stat`/`statSync` be assignable to node's overloaded
// signatures (whose `bigint: true` branch returns `BigIntStats`). Callers still
// get the precise per-overload type through the public `fs` typing.
export type AnyStats = import("node:fs").Stats & import("node:fs").BigIntStats;

export let fsConstants: NodeFs["constants"] = {
	O_RDONLY: 0,
	O_WRONLY: 1,
	O_RDWR: 2,
	S_IFMT: 61440,
	S_IFREG: 32768,
	S_IFDIR: 16384,
	S_IFCHR: 8192,
	S_IFBLK: 24576,
	S_IFIFO: 4096,
	S_IFLNK: 40960,
	S_IFSOCK: 49152,
	O_CREAT: 64,
	O_EXCL: 128,
	UV_FS_O_FILEMAP: 0,
	O_NOCTTY: 256,
	O_TRUNC: 512,
	O_APPEND: 1024,
	O_DIRECTORY: 65536,
	O_NOATIME: 262144,
	O_NOFOLLOW: 131072,
	O_SYMLINK: 2097152, // macos only
	O_SYNC: 1052672,
	O_DSYNC: 4096,
	O_DIRECT: 16384,
	O_NONBLOCK: 2048,
	S_IRWXU: 448,
	S_IRUSR: 256,
	S_IWUSR: 128,
	S_IXUSR: 64,
	S_IRWXG: 56,
	S_IRGRP: 32,
	S_IWGRP: 16,
	S_IXGRP: 8,
	S_IRWXO: 7,
	S_IROTH: 4,
	S_IWOTH: 2,
	S_IXOTH: 1,
	F_OK: 0,
	R_OK: 4,
	W_OK: 2,
	X_OK: 1,
	COPYFILE_EXCL: 1,
	COPYFILE_FICLONE: 2,
	COPYFILE_FICLONE_FORCE: 4,
};

export let bigintDivideAway = (a: bigint, b: bigint) =>
	a / b + (a % b === 0n ? 0n : a > 0n === b > 0n ? 1n : -1n);

// A puterfs directory entry, normalized. Both wire shapes the api speaks reduce
// to this, and `Stats`/`Dirent` are built from it — so field-name and unit
// handling lives in exactly one place (see `normalizeFsEntry`).
export interface FsEntry {
	path: string;
	name: string;
	uid: string;
	isDir: boolean;
	isSymlink: boolean;
	size: number;
	modifiedMs: number;
	createdMs: number;
	accessedMs: number;
}

// puterfs timestamps are unix *seconds*. Missing/garbage becomes 0 (the epoch)
// rather than NaN: node's stat never yields an Invalid Date, and a NaN here
// silently poisons every `mtime` comparison downstream.
function toMs(v: unknown): number {
	let n = Number(v);
	return Number.isFinite(n) ? n * 1000 : 0;
}

// Accepts either wire shape:
//   - v2 camelCase, from `/fs/readdir` (`isDir`, `modified`, ...)
//   - v1 snake_case, from the legacy `/stat` and `/readdir` routes (`is_dir`,
//     and `is_symlink` as an int 0|1)
// Neither has ever had `created_at`/`updated_at`, despite what this runtime used
// to read — the fields are `created`/`modified`/`accessed`.
export function normalizeFsEntry(raw: any): FsEntry {
	return {
		path: raw.path,
		name: raw.name,
		uid: raw.uid ?? raw.uuid ?? raw.id,
		isDir: Boolean(raw.isDir ?? raw.is_dir),
		isSymlink: Boolean(raw.isSymlink ?? raw.is_symlink),
		size: Number(raw.size ?? 0),
		modifiedMs: toMs(raw.modified),
		createdMs: toMs(raw.created),
		accessedMs: toMs(raw.accessed),
	};
}

// The request body every `stat` call sends.
//
// `return_size` is deliberately absent. It only does anything for directories,
// where the backend answers it with `SUM(size)` over the entire subtree — an
// O(descendants) index scan — so a single `statSync` on a project root makes the
// server walk all of node_modules. Node reports a directory's `Stats.size` as a
// block count, never a subtree total, so the field was never usable anyway.
export function statRequest(path: string) {
	return {
		path,
		return_permissions: false,
		return_versions: false,
		consistency: "strong",
	};
}

// Maps Puter API error codes to Node.js fs errno codes.
// Puter error codes are defined in the backend at src/backend/src/api/APIError.js.
// Node.js errno codes follow the POSIX convention used by libuv.
let puterErrorToNodeError: Record<
	string,
	{ code: string; errno: number; message: string }
> = {
	// Not found errors -> ENOENT
	subject_does_not_exist: {
		code: "ENOENT",
		errno: -2,
		message: "no such file or directory",
	},
	source_does_not_exist: {
		code: "ENOENT",
		errno: -2,
		message: "no such file or directory",
	},
	dest_does_not_exist: {
		code: "ENOENT",
		errno: -2,
		message: "no such file or directory",
	},
	shortcut_target_not_found: {
		code: "ENOENT",
		errno: -2,
		message: "no such file or directory",
	},
	offset_without_existing_file: {
		code: "ENOENT",
		errno: -2,
		message: "no such file or directory",
	},

	// Already exists -> EEXIST
	item_with_same_name_exists: {
		code: "EEXIST",
		errno: -17,
		message: "file already exists",
	},

	// Permission errors -> EACCES
	forbidden: {
		code: "EACCES",
		errno: -13,
		message: "permission denied",
	},
	permission_denied: {
		code: "EACCES",
		errno: -13,
		message: "permission denied",
	},
	immutable: {
		code: "EACCES",
		errno: -13,
		message: "permission denied",
	},

	// Directory not empty -> ENOTEMPTY
	not_empty: {
		code: "ENOTEMPTY",
		errno: -39,
		message: "directory not empty",
	},

	// Not a directory / is a directory -> ENOTDIR / EISDIR
	dest_is_not_a_directory: {
		code: "ENOTDIR",
		errno: -20,
		message: "not a directory",
	},
	readdir_of_non_directory: {
		code: "ENOTDIR",
		errno: -20,
		message: "not a directory",
	},
	cannot_read_a_directory: {
		code: "EISDIR",
		errno: -21,
		message: "illegal operation on a directory",
	},
	cannot_overwrite_a_directory: {
		code: "EISDIR",
		errno: -21,
		message: "illegal operation on a directory",
	},

	// Invalid argument errors -> EINVAL
	invalid_file_name: {
		code: "EINVAL",
		errno: -22,
		message: "invalid argument",
	},
	unresolved_relative_path: {
		code: "EINVAL",
		errno: -22,
		message: "invalid argument",
	},
	invalid_operation: {
		code: "EINVAL",
		errno: -22,
		message: "invalid argument",
	},
	// The api's catch-all for a malformed request. Reachable from normal code:
	// a recursive readdir of `/` returns it (see readdir-recursive.ts).
	bad_request: {
		code: "EINVAL",
		errno: -22,
		message: "invalid argument",
	},

	// Self-referential operations -> EINVAL
	cannot_move_item_into_itself: {
		code: "EINVAL",
		errno: -22,
		message: "invalid argument",
	},
	cannot_copy_item_into_itself: {
		code: "EINVAL",
		errno: -22,
		message: "invalid argument",
	},
	source_and_dest_are_the_same: {
		code: "EINVAL",
		errno: -22,
		message: "invalid argument",
	},

	// Cannot write/move/copy to root -> EPERM
	cannot_move_to_root: {
		code: "EPERM",
		errno: -1,
		message: "operation not permitted",
	},
	cannot_copy_to_root: {
		code: "EPERM",
		errno: -1,
		message: "operation not permitted",
	},
	cannot_write_to_root: {
		code: "EPERM",
		errno: -1,
		message: "operation not permitted",
	},

	// Storage limit -> ENOSPC
	storage_limit_reached: {
		code: "ENOSPC",
		errno: -28,
		message: "no space left on device",
	},

	// File too large -> EFBIG
	file_too_large: {
		code: "EFBIG",
		errno: -27,
		message: "file too large",
	},

	// Not supported -> ENOTSUP
	not_yet_supported: {
		code: "ENOTSUP",
		errno: -95,
		message: "operation not supported",
	},
	missing_filesystem_capability: {
		code: "ENOTSUP",
		errno: -95,
		message: "operation not supported",
	},
};

// Translates a Puter API error code string into a Node.js-style fs error object.
// Returns undefined if the error code is not recognized, in which case the caller
// should fall back to a generic Error.
export function translatePuterError(
	puterCode: string,
	syscall?: string,
	path?: string
): (NodeJS.ErrnoException & { code: string; errno: number }) | undefined {
	let mapping = puterErrorToNodeError[puterCode];
	if (!mapping) return undefined;

	let err = new Error(
		`${mapping.code}: ${mapping.message}${syscall ? `, ${syscall}` : ""}${path ? ` '${path}'` : ""}`
	) as NodeJS.ErrnoException & { code: string; errno: number };
	err.code = mapping.code;
	err.errno = mapping.errno;
	if (syscall) err.syscall = syscall;
	if (path) err.path = path;
	return err;
}

// Coerces a path-like value (string, Buffer, or URL) to a string.
// Follows Node.js fs conventions:
// - string: returned as-is
// - Buffer: decoded as UTF-8
// - URL: must have 'file:' protocol; pathname is extracted and decoded
// - number (file descriptor): throws, as Puter does not support file descriptors
// Throws TypeError for invalid inputs, matching Node.js behavior.
export function toPathString(path: string | Buffer | URL | number): string {
	if (typeof path === "string") return path;
	if (typeof path === "number")
		throw new TypeError("File descriptors are not supported");
	if (path instanceof Buffer) return path.toString("utf8");
	if (path instanceof URL) {
		if (path.protocol !== "file:")
			throw new TypeError(
				`The URL must be of scheme file, received ${path.protocol}`
			);
		// Decode percent-encoded characters in the pathname
		return decodeURIComponent(path.pathname);
	}
	throw new TypeError(
		'The "path" argument must be of type string, Buffer, or URL'
	);
}

export function normalizePath(path: string | Buffer | URL | number): string {
	const pathStr = toPathString(path);
	if (pathStr.startsWith("/")) return pathStr;
	return nodePath.join(CWD, pathStr);
}

// Builds a Node-style fs error (code/errno/syscall/path) for cases where there
// is no Puter API error to translate (bad flags, bad fd, validation, ...).
export function createFsError(
	code: string,
	errno: number,
	message: string,
	syscall: string,
	path?: string
): NodeJS.ErrnoException & { code: string; errno: number } {
	const err = new Error(
		`${code}: ${message}, ${syscall}${path ? ` '${path}'` : ""}`
	) as NodeJS.ErrnoException & { code: string; errno: number };
	err.code = code;
	err.errno = errno;
	err.syscall = syscall;
	if (path) err.path = path;
	return err;
}

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
		throw createFsError(
			"EINVAL",
			-22,
			"numeric open flags are not supported",
			"open"
		);
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
	if (!parsed) throw createFsError("EINVAL", -22, "invalid flags", "open");
	return parsed;
}

// Generates a 6-character random suffix for mkdtemp(), matching Node's length.
export function randomTempSuffix(): string {
	const alphabet =
		"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let out = "";
	for (let i = 0; i < 6; i++)
		out += alphabet[Math.floor(Math.random() * alphabet.length)];
	return out;
}
