/** Async network operations. Credentials and relay configuration stay on the page. */
export type NetCall =
	| {
			op: "net.fetch";
			url: string;
			method?: string;
			headers: [string, string][];
			redirect?: RequestRedirect;
			credentials?: RequestCredentials;
			cache?: RequestCache;
			mode?: RequestMode;
			referrer?: string;
			referrerPolicy?: ReferrerPolicy;
			integrity?: string;
			keepalive?: boolean;
			hasBody: boolean;
	  }
	| {
			op: "net.websocket";
			url: string;
			protocols?: string[];
			headers?: [string, string][];
	  }
	| { op: "net.tcp"; host: string; port: number; bufferSize?: number }
	| {
			op: "net.tls";
			host: string;
			port: number;
			bufferSize?: number;
			alpn?: string[];
	  };

export interface NetFetchResult {
	status: number;
	statusText: string;
	headers: [string, string][];
	rawHeaders?: unknown;
	url: string;
	redirected: boolean;
	type: ResponseType;
	hasBody: boolean;
}

export interface NetWebSocketResult {
	protocol: string;
	headers: [string, string][];
	rawHeaders: unknown;
}

export interface NetTlsResult {
	negotiatedProtocol: string | null;
	protocolVersion: string | null;
	cipherSuite: string | null;
	peerCertificates: number[][];
}
