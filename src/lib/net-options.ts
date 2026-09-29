/** Network configuration held by the page for a worker started without a puter token. */
export interface NodeNetInit {
	/** Relay URL, dialed exactly as provided. A v1 path token stays in the path. */
	wispUrl?: string;
	/** Password for the Wisp 0x02 extension; omit for an unauthenticated relay. */
	relayToken?: string;
	/** Stable anonymous identity sent to the peer signaller. */
	peerToken?: string;
}
