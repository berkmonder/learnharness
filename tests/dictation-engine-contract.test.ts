import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
	CUSTOM_DICTATION_MAX_MS, DICTATION_ENGINES, DICTATION_MODEL_MAX_LENGTH, DICTATION_SAMPLE_RATE,
	encodeWav, isDictationEngine, whisperLanguage,
} from "../src/core/dictation.ts";
import { FACTORY_SETTINGS, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { MAX_IMPORT_BODY_BYTES } from "../lib/notes-import-limits.ts";

describe("dictation engine contract", () => {
	it("offers Deepgram and the custom endpoint; Deepgram stays the factory engine", () => {
		assert.deepEqual(DICTATION_ENGINES.map(({ id, label }) => [id, label]), [["deepgram", "Deepgram"], ["custom", "Custom endpoint"]]);
		assert.equal(FACTORY_SETTINGS.dictation.engine, "deepgram");
		for (const value of ["deepgram", "custom"]) assert.ok(isDictationEngine(value));
		for (const value of ["speaches", "", null, 1, "Custom"]) assert.equal(isDictationEngine(value), false, String(value));
	});

	it("shares the Language setting with Whisper: regions drop, Multilingual auto-detects", () => {
		assert.equal(whisperLanguage("multi"), undefined);
		assert.equal(whisperLanguage("en"), "en");
		assert.equal(whisperLanguage("en-GB"), "en");
		assert.equal(whisperLanguage("tr-TR"), "tr");
		assert.equal(whisperLanguage("zh-Hant"), "zh");
		assert.equal(whisperLanguage("es-419"), "es");
	});

	it("encodes mono linear16 frames as one 16 kHz WAV", () => {
		const frames = [Int16Array.from([1, -2, 32767]), Int16Array.from([-32768])];
		const wav = encodeWav(frames);
		const view = new DataView(wav);
		const ascii = (offset: number, length: number) => String.fromCharCode(...new Uint8Array(wav, offset, length));
		assert.equal(wav.byteLength, 44 + 4 * 2);
		assert.equal(ascii(0, 4), "RIFF");
		assert.equal(view.getUint32(4, true), 36 + 8);
		assert.equal(ascii(8, 8), "WAVEfmt ");
		assert.equal(view.getUint16(20, true), 1, "PCM");
		assert.equal(view.getUint16(22, true), 1, "mono");
		assert.equal(view.getUint32(24, true), DICTATION_SAMPLE_RATE);
		assert.equal(view.getUint32(28, true), DICTATION_SAMPLE_RATE * 2);
		assert.equal(view.getUint16(34, true), 16);
		assert.equal(ascii(36, 4), "data");
		assert.equal(view.getUint32(40, true), 8);
		assert.deepEqual([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true)), [1, -2, 32767, -32768]);
		assert.equal(encodeWav([]).byteLength, 44);
	});

	it("a full 12-minute run fits the API body cap", () => {
		const bytes = 44 + (CUSTOM_DICTATION_MAX_MS / 1000) * DICTATION_SAMPLE_RATE * 2;
		assert.ok(bytes < MAX_IMPORT_BODY_BYTES, `${bytes} < ${MAX_IMPORT_BODY_BYTES}`);
	});

	it("the body parser accepts engine and model, strictly", () => {
		assert.deepEqual(
			parseDictationSettingsBody({ language: "en", engine: "custom", model: "whisper-1" }),
			{ ok: true, settings: { language: "en", engine: "custom", model: "whisper-1" } },
		);
		assert.deepEqual(parseDictationSettingsBody({ engine: "deepgram" }), { ok: true, settings: { engine: "deepgram" } });
		for (const body of [
			{ engine: "speaches" }, { engine: null }, { model: "" }, { model: " whisper-1" }, { model: 3 },
			{ model: "m".repeat(DICTATION_MODEL_MAX_LENGTH + 1) }, { language: "xx", engine: "custom" },
		]) assert.equal(parseDictationSettingsBody(body).ok, false, JSON.stringify(body));
		assert.ok(parseDictationSettingsBody({ model: "m".repeat(DICTATION_MODEL_MAX_LENGTH) }).ok);
	});

	it("the sanitizer keeps each valid field on its own and resolution fills the factory engine", () => {
		const record = sanitizeUserSettings({ version: 1, dictation: { language: "xx", engine: "custom", model: "whisper-1" } });
		assert.deepEqual(record?.dictation, { engine: "custom", model: "whisper-1" });
		assert.deepEqual(resolveSettings(record).dictation, { language: "en", engine: "custom", model: "whisper-1" });
		const badModel = sanitizeUserSettings({ version: 1, dictation: { language: "pl", engine: "nope", model: "" } });
		assert.deepEqual(badModel?.dictation, { language: "pl" });
		assert.deepEqual(resolveSettings(badModel).dictation, { language: "pl", engine: "deepgram" });
		assert.deepEqual(resolveSettings(null).dictation, { language: "en", engine: "deepgram" });
	});
});

const testData = mkdtempSync(path.join(tmpdir(), "lh-dictation-engine-"));
process.env.LH_DATA_DIR = testData;
after(() => { rmSync(testData, { recursive: true, force: true }); });
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

it("the section route stores the whole dictation section and rejects a bad engine without writing", async () => {
	const { PUT } = await import("../app/api/settings/[section]/route.ts");
	writeSettings({ version: 1 });
	const put = (body: unknown) => PUT(new Request("http://localhost/api/settings/dictation", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ section: "dictation" }) });
	const section = { language: "tr-TR", engine: "custom", model: "whisper-1" };
	assert.equal((await put(section)).status, 200);
	assert.deepEqual(readSettings()?.dictation, section);
	assert.equal((await put({ ...section, engine: "speaches" })).status, 400);
	assert.deepEqual(readSettings()?.dictation, section);
});
