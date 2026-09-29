// Node's upstream primordials are initialized by bootstrap.ts before the runtime
// graph. Use that same saved set in our TypeScript shims, without cloning it.
import primordials from "./node-core/primordials";

export const nodePrimordials = primordials as unknown as {
	ArrayIsArray: typeof Array.isArray;
	ArrayPrototypeJoin: (array: readonly unknown[], separator?: string) => string;
	ArrayPrototypeIncludes: <T>(array: readonly T[], value: T) => boolean;
	ArrayPrototypeSlice: <T>(
		array: readonly T[],
		start?: number,
		end?: number
	) => T[];
	ArrayPrototypeSort: <T>(array: T[], compare?: (a: T, b: T) => number) => T[];
	ArrayPrototypePush: <T>(array: T[], value: T) => number;
	FunctionPrototypeBind: (
		fn: Function,
		thisArg: unknown,
		...args: unknown[]
	) => Function;
	JSONParse: typeof JSON.parse;
	JSONStringify: typeof JSON.stringify;
	MapPrototypeGet: <K, V>(map: Map<K, V>, key: K) => V | undefined;
	MapPrototypeSet: <K, V>(map: Map<K, V>, key: K, value: V) => Map<K, V>;
	MapPrototypeHas: <K, V>(map: Map<K, V>, key: K) => boolean;
	MapPrototypeDelete: <K, V>(map: Map<K, V>, key: K) => boolean;
	MapPrototypeClear: <K, V>(map: Map<K, V>) => void;
	MapPrototypeForEach: <K, V>(
		map: Map<K, V>,
		callback: (value: V, key: K) => void
	) => void;
	MapPrototypeKeys: <K, V>(map: Map<K, V>) => IterableIterator<K>;
	SetPrototypeAdd: <T>(set: Set<T>, value: T) => Set<T>;
	SetPrototypeHas: <T>(set: Set<T>, value: T) => boolean;
	SetPrototypeDelete: <T>(set: Set<T>, value: T) => boolean;
	SetPrototypeForEach: <T>(set: Set<T>, callback: (value: T) => void) => void;
	ObjectAssign: typeof Object.assign;
	ObjectCreate: typeof Object.create;
	ObjectDefineProperty: typeof Object.defineProperty;
	ObjectDefineProperties: typeof Object.defineProperties;
	ObjectEntries: typeof Object.entries;
	ObjectFromEntries: typeof Object.fromEntries;
	ObjectHasOwn: typeof Object.hasOwn;
	ObjectKeys: typeof Object.keys;
	ObjectValues: typeof Object.values;
	ObjectPrototypeHasOwnProperty: (object: object, key: PropertyKey) => boolean;
	StringPrototypeCharCodeAt: (value: string, index: number) => number;
	StringPrototypeEndsWith: (value: string, search: string) => boolean;
	StringPrototypeIncludes: (value: string, search: string) => boolean;
	StringPrototypeIndexOf: (
		value: string,
		search: string,
		position?: number
	) => number;
	StringPrototypeLastIndexOf: (
		value: string,
		search: string,
		position?: number
	) => number;
	StringPrototypeReplace: (
		value: string,
		search: RegExp | string,
		replacement: string
	) => string;
	StringPrototypeSlice: (value: string, start?: number, end?: number) => string;
	StringPrototypeSplit: (value: string, separator: string | RegExp) => string[];
	StringPrototypeStartsWith: (value: string, search: string) => boolean;
};
