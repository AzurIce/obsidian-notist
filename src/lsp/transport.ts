/**
 * stdio JSON-RPC transport for an LSP server process.
 *
 * Spawns the server, frames messages with Content-Length headers, and
 * correlates responses to requests by id. No obsidian imports; Node APIs
 * are required lazily so importing this module never breaks mobile.
 */
import type { ChildProcess } from "child_process";

export interface LspTransportHandlers {
	onNotification(method: string, params: unknown): void;
	/** Process exited (or failed to spawn); all pending requests are rejected. */
	onExit(code: number | null, signal: string | null): void;
	onStderr(text: string): void;
}

interface PendingRequest {
	method: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface JsonRpcResponse {
	id?: number | string | null;
	result?: unknown;
	error?: { code: number; message: string };
	method?: string;
	params?: unknown;
}

function nodeRequire<T>(mod: string): T {
	// Direct require (not import) so esbuild leaves it as a runtime call:
	// on mobile `require` doesn't exist and we fail only when LSP is used.
	const req: NodeRequire | undefined =
		typeof require === "function" ? require : undefined;
	if (!req) throw new Error("Node.js is unavailable (LSP is desktop-only)");
	return req(mod) as T;
}

export class LspTransport {
	private proc: ChildProcess | null = null;
	private buffer: Buffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private exited = false;

	constructor(
		private command: string,
		private args: string[],
		private handlers: LspTransportHandlers,
		private cwd?: string,
	) {}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			let cp: typeof import("child_process");
			try {
				cp = nodeRequire<typeof import("child_process")>("child_process");
			} catch (e) {
				reject(e);
				return;
			}
			let proc: ChildProcess;
			try {
				proc = cp.spawn(this.command, this.args, {
					stdio: ["pipe", "pipe", "pipe"],
					// undefined = inherit Obsidian's cwd (which is arbitrary —
					// e.g. the user's home — so launchers like `cargo run`
					// need an explicit working directory).
					cwd: this.cwd || undefined,
				});
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
				return;
			}
			this.proc = proc;
			// `error` fires for spawn failures (ENOENT etc.); `spawn` confirms
			// the process is up. After spawn, later `error`s mean death.
			const onSpawnError = (err: Error) => reject(err);
			proc.once("error", onSpawnError);
			proc.once("spawn", () => {
				proc.removeListener("error", onSpawnError);
				proc.on("error", () => this.handleExit(null, null));
				resolve();
			});
			proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
			proc.stderr?.on("data", (chunk: Buffer) => {
				this.handlers.onStderr(chunk.toString("utf8"));
			});
			proc.on("exit", (code, signal) => this.handleExit(code, signal));
		});
	}

	request(method: string, params: unknown): Promise<unknown> {
		return this.requestWithId(method, params).promise;
	}

	/** Like request(), but exposes the id so the caller can $/cancelRequest it. */
	requestWithId(
		method: string,
		params: unknown,
	): { id: number; promise: Promise<unknown> } {
		if (!this.proc || this.exited) {
			return {
				id: -1,
				promise: Promise.reject(new Error("LSP server is not running")),
			};
		}
		const id = this.nextId++;
		const promise = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { method, resolve, reject });
		});
		this.send({ jsonrpc: "2.0", id, method, params });
		return { id, promise };
	}

	notify(method: string, params: unknown): void {
		if (!this.proc || this.exited) return;
		this.send({ jsonrpc: "2.0", method, params });
	}

	/** Cooperative cancel for an in-flight request id. */
	cancel(id: number): void {
		this.notify("$/cancelRequest", { id });
	}

	/** LSP shutdown handshake, then exit; force-kill after a grace period. */
	async shutdown(graceMs = 2000): Promise<void> {
		const proc = this.proc;
		if (!proc || this.exited) return;
		try {
			await this.request("shutdown", null);
		} catch {
			// server may already be broken; still try to exit cleanly
		}
		// Listen before sending `exit` — the process may die instantly.
		const exited = new Promise<void>((resolve) => {
			if (this.exited) return resolve();
			const timer = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// already dead
				}
				resolve();
			}, graceMs);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		this.notify("exit", null);
		await exited;
	}

	private send(message: object): void {
		const proc = this.proc;
		if (!proc?.stdin?.writable) return;
		const payload = Buffer.from(JSON.stringify(message), "utf8");
		proc.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
		proc.stdin.write(payload);
	}

	private onData(chunk: Buffer): void {
		this.buffer = this.buffer.length
			? Buffer.concat([this.buffer, chunk])
			: chunk;
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const header = this.buffer.toString("ascii", 0, headerEnd);
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				// Unrecoverable framing error: drop everything and die noisily.
				this.handleExit(null, null);
				return;
			}
			const length = parseInt(match[1], 10);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) return;
			const body = this.buffer.toString("utf8", bodyStart, bodyStart + length);
			this.buffer = this.buffer.subarray(bodyStart + length);
			let message: JsonRpcResponse;
			try {
				message = JSON.parse(body) as JsonRpcResponse;
			} catch {
				continue; // ignore unparseable frame, keep the stream
			}
			this.dispatch(message);
		}
	}

	private dispatch(message: JsonRpcResponse): void {
		if (message.id !== undefined && message.id !== null && !message.method) {
			const id = typeof message.id === "string" ? parseInt(message.id, 10) : message.id;
			const entry = this.pending.get(id);
			if (!entry) return; // late response to a cancelled/superseded request
			this.pending.delete(id);
			if (message.error) {
				entry.reject(
					new Error(`LSP ${entry.method}: ${message.error.message} (${message.error.code})`),
				);
			} else {
				entry.resolve(message.result);
			}
		} else if (message.method) {
			this.handlers.onNotification(message.method, message.params);
		}
	}

	private handleExit(code: number | null, signal: string | null): void {
		if (this.exited) return;
		this.exited = true;
		const error = new Error(
			`LSP server exited (code ${code ?? "?"}, signal ${signal ?? "?"})`,
		);
		for (const entry of this.pending.values()) entry.reject(error);
		this.pending.clear();
		this.handlers.onExit(code, signal);
	}
}
