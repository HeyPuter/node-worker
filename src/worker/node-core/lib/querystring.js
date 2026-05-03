export function escape(str) {
	return encodeURIComponent(String(str));
}

export function unescape(str) {
	try {
		return decodeURIComponent(String(str));
	} catch {
		return String(str);
	}
}

export function stringify(obj, sep = '&', eq = '=') {
	if (!obj || typeof obj !== 'object') return '';
	const parts = [];
	for (const key of Object.keys(obj)) {
		const k = escape(key);
		const v = obj[key];
		if (Array.isArray(v)) {
			for (const item of v) parts.push(`${k}${eq}${escape(item)}`);
		} else if (v !== undefined) {
			parts.push(`${k}${eq}${escape(v)}`);
		}
	}
	return parts.join(sep);
}

export function parse(qs, sep = '&', eq = '=') {
	const result = Object.create(null);
	if (typeof qs !== 'string' || qs.length === 0) return result;

	for (const pair of qs.split(sep)) {
		const i = pair.indexOf(eq);
		let key, value;
		if (i < 0) {
			key = unescape(pair);
			value = '';
		} else {
			key = unescape(pair.slice(0, i));
			value = unescape(pair.slice(i + eq.length));
		}
		if (key in result) {
			const cur = result[key];
			if (Array.isArray(cur)) cur.push(value);
			else result[key] = [cur, value];
		} else {
			result[key] = value;
		}
	}
	return result;
}

export const decode = parse;
export const encode = stringify;

export default { escape, unescape, stringify, parse, encode, decode };
