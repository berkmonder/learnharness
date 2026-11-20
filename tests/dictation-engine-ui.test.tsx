import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { setDictationActive } from "../components/dictation-state.ts";
import { AUTH_KEYS, type AuthKeyStatus, type UserSettings } from "../src/core/index.ts";

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rowIds = () => [...byTest("group-dictation")!.lastElementChild!.children].map((row) => row.getAttribute("data-testid"));

const DEEPGRAM_ROW: AuthKeyStatus = {
	id: "DEEPGRAM_API_KEY", info: AUTH_KEYS.find((key) => key.id === "DEEPGRAM_API_KEY")!,
	present: false, masked: null, source: "none", shadowedByEnv: false,
};

async function fixture(dictation: UserSettings["dictation"], custom: { baseUrl: string; models: { id: string }[] } | null) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(win, { innerWidth: 1280, innerHeight: 900 });
	const state = { record: { version: 1, dictation } as UserSettings, writes: [] as unknown[] };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		HTMLInputElement: win.HTMLInputElement, HTMLSelectElement: win.HTMLSelectElement,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/keys") return Response.json({ keys: [DEEPGRAM_ROW], providers: [] });
			if (url === "/api/settings") return Response.json({ settings: state.record });
			if (url === "/api/custom-provider") {
				return Response.json(custom ? { ...custom, authMode: "apiKey", overrides: {}, manualModels: [], keyPresent: true, keySource: "file", keyReuseRequired: false } : { baseUrl: "", authMode: "keyless", models: [] });
			}
			assert.equal(url, "/api/settings/dictation");
			const body = JSON.parse(init!.body as string);
			state.writes.push(body);
			state.record = { ...state.record, dictation: body };
			return Response.json({ settings: state.record });
		},
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const { createRoot } = await import("react-dom/client");
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	const root = createRoot(doc.getElementById("root")!);
	await act(async () => { root.render(<KeysSection />); });
	await act(async () => { notifySettingsSaved("dictation"); }); // a fresh server record per fixture
	dispose = async () => { await act(async () => { setDictationActive(false); root.unmount(); }); };
	return state;
}

/** Pick an option the way a user does: select it, then the change event. */
async function choose(testid: string, value: string) {
	const select = byTest(testid) as HTMLSelectElement;
	assert(select, testid);
	await act(async () => {
		for (const option of select.querySelectorAll("option")) (option as HTMLOptionElement).selected = option.getAttribute("value") === value;
		Object.defineProperty(select, "value", { configurable: true, get: () => value });
		select.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("Custom endpoint: Engine, Model (endpoint's models), Language and its hint; no Deepgram key row", async () => {
	await fixture({ language: "en", engine: "custom", model: "whisper-1" }, { baseUrl: "http://gateway:8000", models: [{ id: "default" }, { id: "whisper-1" }] });
	assert.deepEqual(rowIds(), ["row-dictation-engine", "row-dictation-model", "row-dictation-language", "dictation-setup-hint"]);
	assert.equal((byTest("dictation-engine") as HTMLSelectElement).value, "custom");
	const model = byTest("dictation-model") as HTMLSelectElement;
	assert.deepEqual([...model.querySelectorAll("option")].map((o) => o.textContent), ["default", "whisper-1"]);
	assert.equal(model.value, "whisper-1");
	assert.match(byTest("row-dictation-model")!.textContent!, /From http:\/\/gateway:8000/);
	assert.equal(byTest("dictation-setup-hint")!.textContent, "Uses your custom endpoint's /audio/transcriptions with its saved key.");
	assert.equal(byTest("key-deepgram_api_key"), null);
});

test("switching back to Deepgram sends the whole section and restores the key row and its hint", async () => {
	const state = await fixture({ language: "tr-TR", engine: "custom", model: "whisper-1" }, { baseUrl: "http://gateway:8000", models: [{ id: "whisper-1" }] });
	await choose("dictation-engine", "deepgram");
	assert.deepEqual(state.writes, [{ language: "tr-TR", engine: "deepgram", model: "whisper-1" }]);
	assert.deepEqual(rowIds(), ["row-dictation-engine", "key-deepgram_api_key", "row-dictation-language", "dictation-setup-hint"]);
	assert.match(byTest("dictation-setup-hint")!.textContent!, /Deepgram API key/);
});

test("no model preselected; picking one keeps language and engine", async () => {
	const state = await fixture({ language: "en", engine: "custom" }, { baseUrl: "http://gateway:8000", models: [{ id: "default" }, { id: "whisper-1" }] });
	const model = byTest("dictation-model") as HTMLSelectElement;
	assert.equal(model.querySelector("option")!.textContent, "Pick a model");
	await choose("dictation-model", "whisper-1");
	assert.deepEqual(state.writes, [{ language: "en", engine: "custom", model: "whisper-1" }]);
});

test("without a custom endpoint the Model row says to add one first", async () => {
	await fixture({ language: "en", engine: "custom" }, null);
	assert.equal(byTest("dictation-model-missing")!.textContent, "Add a custom endpoint first");
	assert.equal(byTest("dictation-model"), null);
});

test("a live run locks the Engine and Model rows like Language", async () => {
	await fixture({ language: "en", engine: "custom", model: "whisper-1" }, { baseUrl: "http://gateway:8000", models: [{ id: "whisper-1" }] });
	await act(async () => { setDictationActive(true); });
	assert.equal((byTest("dictation-engine") as HTMLSelectElement).disabled, true);
	assert.equal((byTest("dictation-model") as HTMLSelectElement).disabled, true);
	assert.match(byTest("row-dictation-engine")!.className, /opacity-40/);
});
