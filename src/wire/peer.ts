// The peer op set: outbound connections and inbound listeners over WebRTC.
//
// Both ops answer with a *handle* rather than a value — a stream pair for a connection, a
// port for a listener — so both are async only. That is the whole reason attachments
// exist: a peer connection is not something an XHR body can carry, and pretending
// otherwise would mean a second protocol for the two ops that need one.

/** One peer operation. Worker → page. */
export type PeerCall =
	/** Reply attaches `{readable, writable}` for the connection. */
	| {
			op: "peer.connect";
			token: string;
			code: string;
			signaller: string;
			ice: RTCIceServer[];
			/** `token` is an `anonToken` rather than a puter `authToken`. */
			anon?: boolean;
	  }
	/**
	 * Reply attaches a `MessagePort` carrying one `{readable, writable}` per accepted
	 * connection, and answers with the code peers dial.
	 */
	| {
			op: "peer.listen";
			token: string;
			port: number;
			signaller: string;
			ice: RTCIceServer[];
			anon?: boolean;
	  };

export interface PeerResults {
	"peer.connect": null;
	"peer.listen": { code: string };
}

export type PeerOpName = PeerCall["op"];
export type PeerResult<K extends PeerOpName> = PeerResults[K];
