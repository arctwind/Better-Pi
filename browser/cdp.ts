const OPERATION_TIMEOUT_MS = 15_000;

export function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid DevTools response.");
	return value as Record<string, unknown>;
}

export function stringField(value: unknown, key: string): string {
	const field = record(value)[key];
	if (typeof field !== "string") throw new Error(`DevTools response is missing "${key}".`);
	return field;
}

export interface CdpMessage {
	id?: number;
	method?: string;
	sessionId?: string;
	result?: unknown;
	params?: unknown;
	error?: { message?: string };
}

export interface CdpConnection {
	isOpen(): boolean;
	send(method: string, params?: Record<string, unknown>, sessionId?: string, signal?: AbortSignal): Promise<unknown>;
	wait(method: string, sessionId: string, signal: AbortSignal): Promise<void>;
	close(): void;
}

export async function connect(url: string, signal: AbortSignal, onEvent: (message: CdpMessage) => void, onClose: () => void): Promise<CdpConnection> {
	signal.throwIfAborted();
	const socket = new WebSocket(url);
	const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	const listeners = new Set<(message: CdpMessage) => void>();
	const failures = new Set<(error: Error) => void>();
	let nextId = 1;
	let failure: Error | undefined;
	const fail = (error: Error) => {
		if (failure) return;
		failure = error;
		for (const request of pending.values()) request.reject(error);
		pending.clear();
		for (const reject of failures) reject(error);
		failures.clear();
		onClose();
	};
	socket.addEventListener("close", () => fail(new Error("The browser connection closed. Use browser open to start it again.")));
	socket.addEventListener("error", () => fail(new Error("The browser debugging connection failed.")));
	socket.addEventListener("message", (event) => {
		let message: CdpMessage;
		try {
			if (typeof event.data !== "string") throw new Error("DevTools message must be text.");
			message = record(JSON.parse(event.data));
			if (message.id !== undefined && !Number.isInteger(message.id)) throw new Error("Invalid DevTools response ID.");
			if (message.id === undefined && typeof message.method !== "string") throw new Error("Invalid DevTools event method.");
		} catch (error) {
			fail(new Error("Invalid DevTools message.", { cause: error }));
			socket.close();
			return;
		}
		if (message.id !== undefined) {
			const request = pending.get(message.id);
			if (!request) return;
			pending.delete(message.id);
			if (message.error) request.reject(new Error(message.error.message ?? "DevTools command failed."));
			else request.resolve(message.result);
		} else {
			try {
				onEvent(message);
				for (const listener of listeners) listener(message);
			} catch (error) {
				fail(new Error("Invalid DevTools event.", { cause: error }));
				socket.close();
			}
		}
	});
	try {
		await new Promise<void>((resolveOpen, rejectOpen) => {
			const cleanup = () => {
				socket.removeEventListener("open", onOpen);
				socket.removeEventListener("error", onError);
				socket.removeEventListener("close", onError);
				signal.removeEventListener("abort", onAbort);
			};
			const onOpen = () => { cleanup(); resolveOpen(); };
			const onError = () => { cleanup(); rejectOpen(failure ?? new Error("Could not connect to the browser.")); };
			const onAbort = () => { cleanup(); rejectOpen(signal.reason); };
			socket.addEventListener("open", onOpen, { once: true });
			socket.addEventListener("error", onError, { once: true });
			socket.addEventListener("close", onError, { once: true });
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
	} catch (error) {
		socket.close();
		throw error;
	}
	return {
		isOpen: () => socket.readyState === WebSocket.OPEN && !failure,
		send(method, params = {}, sessionId, signal) {
			if (signal?.aborted) return Promise.reject(signal.reason);
			if (failure || socket.readyState !== WebSocket.OPEN) return Promise.reject(failure ?? new Error("The browser is closed."));
			return new Promise((resolveSend, rejectSend) => {
				const id = nextId++;
				const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); pending.delete(id); };
				const reject = (error: Error) => { cleanup(); rejectSend(error); };
				const onAbort = () => reject(signal?.reason);
				const timer = setTimeout(() => reject(new Error(`Browser command timed out: ${method}`)), OPERATION_TIMEOUT_MS);
				pending.set(id, { resolve(value) { cleanup(); resolveSend(value); }, reject });
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) { onAbort(); return; }
				try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
				catch (error) { cleanup(); rejectSend(error); }
			});
		},
		wait(method, sessionId, signal) {
			return new Promise<void>((resolveWait, rejectWait) => {
				const cleanup = () => {
					listeners.delete(onMessage);
					failures.delete(onFailure);
					signal.removeEventListener("abort", onAbort);
					socket.removeEventListener("close", onClose);
				};
				const onAbort = () => { cleanup(); rejectWait(signal.reason); };
				const onClose = () => { cleanup(); rejectWait(failure ?? new Error("The browser is closed.")); };
				const onFailure = (error: Error) => { cleanup(); rejectWait(error); };
				const onMessage = (message: CdpMessage) => {
					if (message.method === method && message.sessionId === sessionId) { cleanup(); resolveWait(); }
				};
				listeners.add(onMessage);
				failures.add(onFailure);
				signal.addEventListener("abort", onAbort, { once: true });
				socket.addEventListener("close", onClose, { once: true });
				if (signal.aborted) onAbort();
				else if (failure) onClose();
			});
		},
		close() { fail(new Error("The browser was closed.")); socket.close(); },
	};
}
