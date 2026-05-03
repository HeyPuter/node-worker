export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export function parse(urlString, _parseQueryString, _slashesDenoteHost) {
	try {
		const u = new URL(urlString);
		return {
			href: u.href,
			origin: u.origin,
			protocol: u.protocol,
			username: u.username,
			password: u.password,
			host: u.host,
			hostname: u.hostname,
			port: u.port,
			pathname: u.pathname,
			search: u.search,
			searchParams: u.searchParams,
			hash: u.hash,
			path: u.pathname + u.search,
			query: u.search ? u.search.slice(1) : null,
			slashes: true,
		};
	} catch {
		return {};
	}
}

export function format(urlObject) {
	if (urlObject instanceof URL) return urlObject.toString();
	const protocol = urlObject.protocol || '';
	const host = urlObject.host || urlObject.hostname || '';
	const path = urlObject.pathname || urlObject.path || '';
	const search = urlObject.search || (urlObject.query ? `?${urlObject.query}` : '');
	const hash = urlObject.hash || '';
	return `${protocol}//${host}${path}${search}${hash}`;
}

export function resolve(from, to) {
	try {
		return new URL(to, from).toString();
	} catch {
		return to;
	}
}

export function fileURLToPath(input) {
	const u = input instanceof URL ? input : new URL(input);
	if (u.protocol !== 'file:') {
		throw new TypeError(`The URL must be of scheme file, received ${u.protocol}`);
	}
	return decodeURIComponent(u.pathname);
}

export function pathToFileURL(p) {
	return new URL('file://' + (p.startsWith('/') ? p : '/' + p));
}

export function urlToHttpOptions(u) {
	return {
		protocol: u.protocol,
		hostname: u.hostname,
		hash: u.hash,
		search: u.search,
		pathname: u.pathname,
		path: `${u.pathname}${u.search}`,
		href: u.href,
		port: u.port,
		auth: u.username ? `${u.username}:${u.password}` : null,
	};
}

export function domainToASCII(d) {
	return d;
}

export function domainToUnicode(d) {
	return d;
}

export default {
	URL,
	URLSearchParams,
	parse,
	format,
	resolve,
	fileURLToPath,
	pathToFileURL,
	urlToHttpOptions,
	domainToASCII,
	domainToUnicode,
};
