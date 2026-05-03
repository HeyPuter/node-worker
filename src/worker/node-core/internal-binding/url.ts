// `internalBinding('url')` — only the bits upstream JS code actually pulls in.
// `canParse` ships as a static on the global URL since 2024.

export default {
	canParse(input: string, base?: string): boolean {
		return URL.canParse(input, base);
	},
	domainToASCII(input: string): string {
		try {
			return new URL(`http://${input}`).hostname;
		} catch {
			return "";
		}
	},
	domainToUnicode(input: string): string {
		return input;
	},
};
