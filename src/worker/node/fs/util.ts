import { buffer as nodeBuffer, path as nodePath } from "../polyfills";
import { CWD } from "../../state";

let Buffer = nodeBuffer.Buffer;

type NodeFs = typeof import("node:fs");

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
