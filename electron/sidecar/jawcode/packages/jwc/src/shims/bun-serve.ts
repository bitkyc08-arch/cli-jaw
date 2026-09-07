/**
 * `Bun.serve` Node adapter (100.07 / inventory J).
 *
 * Covers the fetch-handler HTTP shape used by the OAuth callback server, the
 * py tool-bridge, and the bridge mode: `serve({ hostname, port, tls, fetch })
 * → { port, stop }`. TLS is honored via node:https (audit SQ-2 — dropping it
 * served bridge bearer tokens in cleartext). WebSocket upgrade is deferred —
 * passing a `websocket` option throws.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { Readable } from "node:stream";

interface BunServeTlsOptions {
	cert?: string | Buffer;
	key?: string | Buffer;
	ca?: string | Buffer;
	passphrase?: string;
	serverName?: string;
}

interface BunServeOptions {
	hostname?: string;
	port?: number;
	reusePort?: boolean;
	tls?: BunServeTlsOptions;
	fetch: (request: Request) => Response | Promise<Response>;
	websocket?: unknown;
	error?: (error: Error) => Response | Promise<Response>;
}

function toRequest(
	req: IncomingMessage,
	hostname: string,
	port: number,
	scheme: "http" | "https",
	signal: AbortSignal,
): Request {
	const url = `${scheme}://${hostname}:${port}${req.url ?? "/"}`;
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (typeof value === "string") headers.set(key, value);
		else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
	}
	const method = req.method ?? "GET";
	const body = method === "GET" || method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream);
	return new Request(url, {
		method,
		headers,
		body,
		// request.signal must fire on client disconnect so handlers abort their
		// upstream work (audit round-4 — auth-gateway streaming kept burning
		// tokens after the client hung up).
		signal,
		// @ts-expect-error: required by undici for streamed request bodies
		duplex: body ? "half" : undefined,
	});
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
	const headers: Record<string, string | string[]> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	res.writeHead(response.status, headers);
	if (response.body) {
		// Cancel the source stream when the client disconnects, so SSE
		// producers (BridgeEventStream) run their ReadableStream cancel() and
		// drop the subscriber instead of leaking forever (audit SQ-4).
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		let aborted = false;
		const onClose = () => {
			aborted = true;
			reader.cancel().catch(() => {});
		};
		res.once("close", onClose);
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done || aborted) break;
				if (!res.write(value)) {
					await new Promise<void>(resolve => res.once("drain", resolve));
				}
			}
		} finally {
			res.removeListener("close", onClose);
		}
	}
	if (!res.writableEnded) res.end();
}

export function bunServe(options: BunServeOptions) {
	if (options.websocket) {
		throw new Error("Bun.serve shim: websocket upgrade is deferred on Node");
	}
	const hostname = options.hostname ?? "0.0.0.0";
	const requestedPort = options.port ?? 0;
	const useTls = Boolean(options.tls?.cert && options.tls?.key);
	const scheme: "http" | "https" = useTls ? "https" : "http";

	const handler = (req: IncomingMessage, res: ServerResponse) => {
		// Abort request.signal when the client disconnects before the response
		// finishes, so streaming handlers cancel upstream work.
		const requestAbort = new AbortController();
		const abortOnDisconnect = () => {
			if (!res.writableEnded) requestAbort.abort();
		};
		req.once("aborted", () => requestAbort.abort());
		res.once("close", abortOnDisconnect);
		Promise.resolve()
			.then(() => options.fetch(toRequest(req, hostname, boundPort(), scheme, requestAbort.signal)))
			.catch(async error => {
				if (options.error) return options.error(error instanceof Error ? error : new Error(String(error)));
				return new Response("Internal Server Error", { status: 500 });
			})
			.then(response => writeResponse(res, response ?? new Response("", { status: 204 })))
			.catch(() => {
				res.statusCode = 500;
				res.end();
			});
	};

	const server = useTls
		? createHttpsServer(
				{
					cert: options.tls?.cert,
					key: options.tls?.key,
					ca: options.tls?.ca,
					passphrase: options.tls?.passphrase,
				},
				handler,
			)
		: createHttpServer(handler);

	server.listen(requestedPort, hostname);
	const boundPort = () => {
		const address = server.address();
		return typeof address === "object" && address ? address.port : requestedPort;
	};

	return {
		get port(): number {
			return boundPort();
		},
		get hostname(): string {
			return hostname;
		},
		get url(): URL {
			return new URL(`${scheme}://${hostname}:${boundPort()}/`);
		},
		stop(_closeActiveConnections?: boolean): void {
			server.close();
			server.closeAllConnections?.();
		},
		ref(): void {
			server.ref();
		},
		unref(): void {
			server.unref();
		},
	};
}
