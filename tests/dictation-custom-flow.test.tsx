import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { parseHTML } from "linkedom";
import { DICTATION_NO_ENDPOINT, DICTATION_NO_MODEL, dictationErrorSettingsTarget, useDictation, type Dictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { CUSTOM_DICTATION_MAX_MS, type UserSettings } from "../src/core/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static all: Worklet[] = [];
	port: { onmessage?: (event: { data: unknown }) => void } = {};
	constructor() { Worklet.all.push(this); }
	connect() {}
	disconnect() {}
	/** One 128 ms capture frame, as the real worklet posts it. */
	frame(value = 1) { this.port.onmessage?.({ data: { type: "audio", buffer: new Int16Array(2048).fill(value) } }); }
}

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

type Upload = { body: ArrayBuffer; contentType: string | null; signal: AbortSignal };

async function fixture(dictation: UserSettings["dictation"] = { language: "en", engine: "custom", model: "whisper-1" }) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		record: { version: 1, dictation } as UserSettings,
		ready: undefined as Promise<Response> | undefined,
		upload: undefined as Promise<Response> | undefined,
		uploads: [] as Upload[],
		urls: [] as string[],
		sockets: 0,
		captures: 0,
		stops: 0,
		appends: [] as string[],
	};
	Worklet.all = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			state.captures++;
			return { getTracks: () => [{ stop() { state.stops++; } }] };
		} } },
		WebSocket: class { constructor() { state.sockets++; } },
		AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			state.urls.push(`${init?.method ?? "GET"} ${url}`);
			if (url === "/api/settings") return Response.json({ settings: state.record });
			if (url === "/api/stt/transcribe" && init?.method === "POST") {
				state.uploads.push({ body: init.body as ArrayBuffer, contentType: new Headers(init.headers).get("content-type"), signal: init.signal! });
				const pending = state.upload ?? Promise.resolve(Response.json({ text: "Merhaba dünya" }));
				state.upload = undefined;
				return new Promise<Response>((resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
					void pending.then(resolve);
				});
			}
			if (url === "/api/stt/transcribe") return state.ready ?? Response.json({ ready: true });
			throw new Error(`unexpected fetch ${url}`);
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		return null;
	}
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	// A new server record per fixture: drop the window-lifetime cache.
	await act(async () => { notifySettingsSaved("dictation"); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return {
		state,
		get dictation() { return latest; },
		get worklet() { return Worklet.all.at(-1)!; },
	};
}

afterEach(async () => { mock.timers.reset(); await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("records the whole run and uploads one WAV at Stop; the text lands once", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.state.sockets, 0, "no Deepgram socket");
	assert.ok(!f.state.urls.some((url) => url.includes("/api/stt/token")), "no Deepgram token");
	await act(async () => { f.worklet.frame(1); f.worklet.frame(2); });
	const upload = deferred<Response>();
	f.state.upload = upload.promise;
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(f.state.stops, 1, "the mic dies first");
	assert.equal(f.state.uploads.length, 1);
	const { body, contentType } = f.state.uploads[0]!;
	assert.equal(contentType, "audio/wav");
	assert.equal(body.byteLength, 44 + 2 * 2048 * 2);
	assert.equal(String.fromCharCode(...new Uint8Array(body, 0, 4)), "RIFF");
	assert.equal(new DataView(body).getInt16(44, true), 1);
	assert.equal(new DataView(body).getInt16(44 + 2048 * 2, true), 2);
	assert.deepEqual(f.state.appends, []);
	await act(async () => { upload.resolve(Response.json({ text: "Merhaba dünya" })); });
	assert.deepEqual(f.state.appends, ["Merhaba dünya"]);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, null);
});

test("finish() resolves only after the transcribed text is in the input", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.worklet.frame(); });
	const upload = deferred<Response>();
	f.state.upload = upload.promise;
	let finished = false;
	await act(async () => { void f.dictation.finish().then(() => { finished = true; }); });
	assert.equal(finished, false);
	await act(async () => { upload.resolve(Response.json({ text: "the reasoning" })); });
	assert.equal(finished, true);
	assert.deepEqual(f.state.appends, ["the reasoning"]);
});

test("Esc during the upload aborts it and discards the run", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.worklet.frame(); });
	f.state.upload = new Promise(() => {}); // never answers on its own
	await act(async () => { f.dictation.stop(); });
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.state.uploads[0]!.signal.aborted, true);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, null);
	assert.deepEqual(f.state.appends, []);
});

test("the run stops itself at 12 minutes and transcribes what it has", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.worklet.frame(); });
	await act(async () => { mock.timers.tick(CUSTOM_DICTATION_MAX_MS - 1); });
	assert.equal(f.dictation.phase, "recording");
	await act(async () => { mock.timers.tick(1); });
	assert.equal(f.state.uploads.length, 1);
	assert.equal(f.state.stops, 1);
	await act(async () => { await Promise.resolve(); });
	assert.deepEqual(f.state.appends, ["Merhaba dünya"]);
	assert.equal(f.dictation.phase, "idle");
});

test("Stop during the readiness check uploads the frames; the late check cannot resume recording", async () => {
	const f = await fixture();
	const ready = deferred<Response>();
	f.state.ready = ready.promise;
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "connecting");
	await act(async () => { f.worklet.frame(); });
	const upload = deferred<Response>();
	f.state.upload = upload.promise;
	await act(async () => { f.dictation.stop(); });
	await act(async () => { ready.resolve(Response.json({ ready: true })); });
	assert.equal(f.dictation.phase, "stopping");
	await act(async () => { upload.resolve(Response.json({ text: "early words" })); });
	assert.deepEqual(f.state.appends, ["early words"]);
	assert.equal(f.dictation.phase, "idle");
});

test("no model chosen: the error says so before the mic opens, and links to Settings", async () => {
	const f = await fixture({ language: "en", engine: "custom" });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.error, DICTATION_NO_MODEL);
	assert.equal(f.state.captures, 0);
	assert.deepEqual(dictationErrorSettingsTarget(DICTATION_NO_MODEL), { section: "keys" });
});

test("an endpoint that is not ready fails fast: mic released, nothing uploaded", async () => {
	const f = await fixture();
	f.state.ready = Promise.resolve(Response.json({ message: "Dictation needs a custom endpoint", code: "no-endpoint" }, { status: 503 }));
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.error, DICTATION_NO_ENDPOINT);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.stops, f.state.captures);
	assert.equal(f.state.uploads.length, 0);
	assert.deepEqual(dictationErrorSettingsTarget(DICTATION_NO_ENDPOINT), { section: "keys" });
});

test("a failed transcription shows the route's line and appends nothing", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.worklet.frame(); });
	f.state.upload = Promise.resolve(Response.json({ message: "Transcription failed (HTTP 500)" }, { status: 502 }));
	await act(async () => { f.dictation.stop(); });
	await act(async () => { await Promise.resolve(); });
	assert.equal(f.dictation.error, "Transcription failed (HTTP 500)");
	assert.equal(dictationErrorSettingsTarget(f.dictation.error), null, "click = retry");
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.dictation.phase, "idle");
});
