import { FileHandle } from "./handle";
import { createFsError } from "./util";
import { fdTable } from "./fd-table";

// Callback-style fd operations (fs.open / fs.read / fs.write / ...). These are
// NOT produced by depromisify(): node's open callback yields a numeric fd (not a
// FileHandle), and read/write callbacks pass two result args, so they're written
// out by hand here. Each fd opened through this family is backed by an async
// `FileHandle` registered in the shared fd table.

// Looks up an fd that must be backed by an async FileHandle. A fd opened with
// the sync family (openSync) lives in the same table but isn't a FileHandle, so
// it's rejected here with EBADF rather than misbehaving.
function getAsyncHandle(fd: number, syscall: string): FileHandle {
	const handle = fdTable.get(fd);
	if (!(handle instanceof FileHandle))
		throw createFsError("EBADF", -9, "bad file descriptor", syscall);
	return handle;
}

type Cb = (err: NodeJS.ErrnoException | null, ...rest: any[]) => void;

export let fdOps = {
	open(path: any, flagsOrCb?: any, modeOrCb?: any, cb?: Cb) {
		let flags: any;
		let callback: Cb;
		if (typeof flagsOrCb === "function") {
			callback = flagsOrCb;
			flags = undefined;
		} else if (typeof modeOrCb === "function") {
			callback = modeOrCb;
			flags = flagsOrCb;
		} else {
			callback = cb as Cb;
			flags = flagsOrCb;
		}
		FileHandle.open(path, flags).then(
			(handle) => callback(null, handle.fd),
			(err) => callback(err)
		);
	},

	close(fd: number, callback?: Cb) {
		const cb = callback ?? (() => {});
		let handle: FileHandle;
		try {
			handle = getAsyncHandle(fd, "close");
		} catch (err) {
			return cb(err as NodeJS.ErrnoException);
		}
		handle.close().then(
			() => cb(null),
			(err) => cb(err)
		);
	},

	read(fd: number, ...args: any[]) {
		const callback = args.pop() as Cb;
		let handle: FileHandle;
		try {
			handle = getAsyncHandle(fd, "read");
		} catch (err) {
			return callback(err as NodeJS.ErrnoException);
		}
		(handle.read as any)(...args).then(
			(res: { bytesRead: number; buffer: NodeJS.ArrayBufferView }) =>
				callback(null, res.bytesRead, res.buffer),
			(err: NodeJS.ErrnoException) => callback(err)
		);
	},

	write(fd: number, ...args: any[]) {
		const callback = args.pop() as Cb;
		let handle: FileHandle;
		try {
			handle = getAsyncHandle(fd, "write");
		} catch (err) {
			return callback(err as NodeJS.ErrnoException);
		}
		(handle.write as any)(...args).then(
			(res: { bytesWritten: number; buffer: any }) =>
				callback(null, res.bytesWritten, res.buffer),
			(err: NodeJS.ErrnoException) => callback(err)
		);
	},

	fstat(fd: number, optionsOrCb: any, cb?: Cb) {
		const callback = (
			typeof optionsOrCb === "function" ? optionsOrCb : cb
		) as Cb;
		const options = typeof optionsOrCb === "function" ? undefined : optionsOrCb;
		let handle: FileHandle;
		try {
			handle = getAsyncHandle(fd, "fstat");
		} catch (err) {
			return callback(err as NodeJS.ErrnoException);
		}
		handle.stat(options).then(
			(stats) => callback(null, stats),
			(err) => callback(err)
		);
	},

	fsync(fd: number, callback: Cb) {
		let handle: FileHandle;
		try {
			handle = getAsyncHandle(fd, "fsync");
		} catch (err) {
			return callback(err as NodeJS.ErrnoException);
		}
		handle.sync().then(
			() => callback(null),
			(err) => callback(err)
		);
	},

	fdatasync(fd: number, callback: Cb) {
		let handle: FileHandle;
		try {
			handle = getAsyncHandle(fd, "fdatasync");
		} catch (err) {
			return callback(err as NodeJS.ErrnoException);
		}
		handle.datasync().then(
			() => callback(null),
			(err) => callback(err)
		);
	},

	ftruncate(fd: number, lenOrCb: any, cb?: Cb) {
		const callback = (typeof lenOrCb === "function" ? lenOrCb : cb) as Cb;
		const len = typeof lenOrCb === "function" ? 0 : (lenOrCb ?? 0);
		let handle: FileHandle;
		try {
			handle = getAsyncHandle(fd, "ftruncate");
		} catch (err) {
			return callback(err as NodeJS.ErrnoException);
		}
		handle.truncate(len).then(
			() => callback(null),
			(err) => callback(err)
		);
	},

	readv(fd: number, buffers: any, positionOrCb: any, cb?: Cb) {
		const callback = (
			typeof positionOrCb === "function" ? positionOrCb : cb
		) as Cb;
		const position = typeof positionOrCb === "function" ? null : positionOrCb;
		let handle: FileHandle;
		try {
			handle = getAsyncHandle(fd, "readv");
		} catch (err) {
			return callback(err as NodeJS.ErrnoException);
		}
		handle.readv(buffers, position).then(
			(res) => callback(null, res.bytesRead, res.buffers),
			(err) => callback(err)
		);
	},

	writev(fd: number, buffers: any, positionOrCb: any, cb?: Cb) {
		const callback = (
			typeof positionOrCb === "function" ? positionOrCb : cb
		) as Cb;
		const position = typeof positionOrCb === "function" ? null : positionOrCb;
		let handle: FileHandle;
		try {
			handle = getAsyncHandle(fd, "writev");
		} catch (err) {
			return callback(err as NodeJS.ErrnoException);
		}
		handle.writev(buffers, position).then(
			(res) => callback(null, res.bytesWritten, res.buffers),
			(err) => callback(err)
		);
	},

	// puterfs has no mode/owner bits; validate the fd and no-op.
	fchmod(fd: number, _mode: any, callback: Cb) {
		try {
			getAsyncHandle(fd, "fchmod");
		} catch (err) {
			return callback(err as NodeJS.ErrnoException);
		}
		callback(null);
	},

	fchown(fd: number, _uid: any, _gid: any, callback: Cb) {
		try {
			getAsyncHandle(fd, "fchown");
		} catch (err) {
			return callback(err as NodeJS.ErrnoException);
		}
		callback(null);
	},
};
