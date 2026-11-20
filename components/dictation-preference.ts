"use client";

import { useSyncExternalStore } from "react";
import {
	FACTORY_SETTINGS, isDictationEngine, isDictationLanguage, isDictationModel, sanitizeUserSettings,
	type DictationEngine, type DictationLanguage, type DictationSettings, type UserSettings,
} from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

const INITIAL = {
	language: undefined as DictationLanguage | undefined,
	/** Resolved engine (absent on disk = the factory's); undefined until loaded. */
	engine: undefined as DictationEngine | undefined,
	/** The custom engine's model id; undefined when unset (or not loaded). */
	model: undefined as string | undefined,
	saving: false,
	error: null as string | null,
};

/** Everything a dictation run needs, confirmed. */
export interface DictationPreference {
	language: DictationLanguage;
	engine: DictationEngine;
	model?: string;
}

/** The dictation section as stored, resolved against the factory. */
function resolveSection(section: DictationSettings | undefined) {
	return {
		language: section?.language ?? FACTORY_SETTINGS.dictation.language,
		engine: section?.engine ?? FACTORY_SETTINGS.dictation.engine,
		model: section?.model,
	};
}

/** One confirmed preference and one write in flight, shared by every surface.
 * The factory keeps transport tests isolated without a second persistence path.
 */
export function createDictationLanguageStore(request: typeof fetch, saved: () => void = () => {}) {
	let snapshot = INITIAL;
	let reading: Promise<DictationLanguage> | null = null;
	let writing: Promise<boolean> | null = null;
	let revision = 0;
	let needsRead = true;
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<typeof INITIAL>) => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};

	function load(refresh = false): Promise<DictationLanguage> {
		if (writing) return getLanguage();
		if (reading && !refresh) return reading;
		if (!refresh && !needsRead && snapshot.language !== undefined) return Promise.resolve(snapshot.language);
		const version = ++revision;
		needsRead = true;
		reading = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings");
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings | null };
				if (!("settings" in body)) throw new Error();
				const record = sanitizeUserSettings(body.settings);
				if (body.settings !== null && record === null) throw new Error();
				if (version !== revision) return getLanguage();
				const { language, engine, model } = resolveSection(record?.dictation);
				needsRead = false;
				publish({ language, engine, model, error: null });
				return language;
			} catch {
				if (version !== revision) return getLanguage();
				const message = "Could not load dictation language. Try again.";
				publish({ error: message });
				throw new Error(message);
			} finally {
				if (version === revision) reading = null;
			}
		});
		return reading;
	}

	/** The route replaces the WHOLE section, so every write sends all of it:
	 * changing the language must never erase the engine or model. */
	function write(patch: Partial<DictationPreference>, what: string): Promise<boolean> {
		// A different selection must never inherit the previous write's success.
		if (writing || snapshot.language === undefined) return Promise.resolve(false);
		const section: DictationSettings = {
			language: snapshot.language,
			...(snapshot.engine !== undefined ? { engine: snapshot.engine } : {}),
			...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
			...patch,
		};
		revision++;
		reading = null;
		writing = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings/dictation", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(section),
				});
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings };
				const confirmed = body.settings?.dictation;
				if (!isDictationLanguage(confirmed?.language)) throw new Error();
				if (confirmed.engine !== undefined && !isDictationEngine(confirmed.engine)) throw new Error();
				if (confirmed.model !== undefined && !isDictationModel(confirmed.model)) throw new Error();
				needsRead = false;
				publish({ ...resolveSection(confirmed), error: null });
				saved();
				return true;
			} catch {
				publish({ error: `Could not save dictation ${what}. Try again.` });
				return false;
			} finally {
				writing = null;
				publish({ saving: false });
			}
		});
		publish({ saving: true, error: null });
		return writing;
	}

	const save = (language: DictationLanguage) => write({ language }, "language");
	const saveEngine = (engine: DictationEngine) => write({ engine }, "engine");
	const saveModel = (model: string) => write({ model }, "model");

	async function getLanguage(): Promise<DictationLanguage> {
		return (await getPreference()).language;
	}

	/** The confirmed section, waiting out any write or read in flight. */
	async function getPreference(): Promise<DictationPreference> {
		for (;;) {
			if (writing) await writing;
			else if (reading) await reading;
			else if (needsRead || snapshot.language === undefined) await load();
			else {
				return {
					language: snapshot.language,
					engine: snapshot.engine ?? FACTORY_SETTINGS.dictation.engine,
					...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
				};
			}
		}
	}

	return {
		load, save, saveEngine, saveModel, getLanguage, getPreference,
		getSnapshot: () => snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

let announcingSave = false;
const store = createDictationLanguageStore((...args) => fetch(...args), () => {
	// All our readers already received the confirmed PUT response. Keep the
	// repo's notification contract without depending on a redundant GET.
	announcingSave = true;
	try { notifySettingsSaved("dictation"); } finally { announcingSave = false; }
});
let readers = 0;
let stopSignals: (() => void) | undefined;

function subscribe(listener: () => void) {
	const off = store.subscribe(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "dictation" && !announcingSave) void store.load(true).catch(() => {});
		});
		// A confirmed preference lives for the window, not the page. Navigation
		// and reopening Settings must not add a new network failure point.
		void store.getLanguage().catch(() => {});
	}
	return () => { off(); if (--readers === 0) { stopSignals?.(); stopSignals = undefined; } };
}

export function useDictationLanguage() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return { ...snapshot, load: store.load, save: store.save, getLanguage: store.getLanguage };
}

/** The same store, with the engine and model writes and the full run read. */
export function useDictationPreference() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return {
		...snapshot,
		load: store.load,
		saveEngine: store.saveEngine,
		saveModel: store.saveModel,
		getPreference: store.getPreference,
	};
}
