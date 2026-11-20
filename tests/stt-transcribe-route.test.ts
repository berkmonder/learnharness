import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stt-transcribe-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), ...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}), NODE_ENV: "test", HOME: scratch, LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
const route = await import("../app/api/stt/transcribe/route.ts");
const { authorizeFixture } = await import("./helpers/custom-provider-auth.ts");
const { encodeWav } = await import("../src/core/dictation.ts");
const { TRANSCRIBE_MAX_BODY_BYTES } = await import("../src/server/transcribe.ts");
type Settings = import("../src/core/settings.ts").UserSettings;
type CustomProvider = import("../src/core/settings.ts").CustomProviderSettings;

const settingsFile = path.join(scratch, "settings.json");
const SECRET = "synthetic-litellm-key-for-tests";
const ENDPOINT: CustomProvider = { baseUrl: "http://gateway:8000/v1", authMode: "apiKey", models: [{ id: "default" }, { id: "whisper-1" }] };
function seed(dictation: Settings["dictation"], cp: CustomProvider | null = ENDPOINT, key: string | null = SECRET) {
	const record: Settings = { version: 1, dictation };
	if (cp) record.customProvider = authorizeFixture(cp, cp.authMode === "apiKey" && key !== null ? key : undefined);
	fs.writeFileSync(settingsFile, JSON.stringify(record));
}
const CUSTOM = { language: "en-GB", engine: "custom", model: "whisper-1" } as const;
const wav = () => encodeWav([new Int16Array(2048).fill(7)]);
const origin = { origin: "http://localhost" };
const post = (body: BodyInit | null = wav(), headers: Record<string, string> = origin) =>
	route.POST(new Request("http://localhost/api/stt/transcribe", { method: "POST", headers: { "content-type": "audio/wav", ...headers }, body }));
// Readiness reads no request: a same-origin browser GET carries no Origin header to check.
const ready = () => route.GET();

let calls: { url: string; authorization: string | null; redirect?: RequestRedirect; form: FormData }[];
let upstream: () => Response | Promise<Response>;
beforeEach(() => {
	delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
	fs.writeFileSync(path.join(scratch, "auth.json"), "{}");
	calls = [];
	upstream = () => Response.json({ text: " Hello there. " });
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect, form: init?.body as FormData });
		assert.ok(init?.signal instanceof AbortSignal);
		return upstream();
	};
});
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; fs.rmSync(scratch, { recursive: true, force: true }); });

test("forwards the WAV as multipart with the bound key, the model and the region-free language", async () => {
	seed(CUSTOM);
	const res = await post();
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { text: "Hello there." });
	assert.equal(calls.length, 1);
	const call = calls[0]!;
	assert.equal(call.url, "http://gateway:8000/v1/audio/transcriptions");
	assert.equal(call.authorization, `Bearer ${SECRET}`);
	assert.equal(call.redirect, "manual");
	assert.equal(call.form.get("model"), "whisper-1");
	assert.equal(call.form.get("language"), "en");
	assert.equal(call.form.get("response_format"), "json");
	const file = call.form.get("file") as File;
	assert.equal(file.name, "audio.wav");
	assert.equal(file.type, "audio/wav");
	assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(wav()));
});

test("Multilingual sends no language; keyless endpoints get no bearer", async () => {
	seed({ ...CUSTOM, language: "multi" }, { ...ENDPOINT, authMode: "keyless" });
	assert.equal((await post()).status, 200);
	assert.equal(calls[0]!.form.get("language"), null);
	assert.equal(calls[0]!.authorization, null);
});

test("readiness mirrors the POST's gates and never calls the endpoint", async () => {
	seed(CUSTOM);
	assert.deepEqual(await (await ready()).json(), { ready: true });
	seed({ ...CUSTOM, engine: "deepgram" });
	assert.deepEqual([(await ready()).status, (await (await ready()).json()).code], [409, "engine"]);
	seed({ language: "en" });
	assert.equal((await ready()).status, 409, "absent engine = the factory's Deepgram");
	seed({ language: "en", engine: "custom" });
	assert.deepEqual(await (await ready()).json(), { message: "Pick a transcription model", code: "no-model" });
	seed(CUSTOM, null);
	assert.deepEqual(await (await ready()).json(), { message: "Dictation needs a custom endpoint", code: "no-endpoint" });
	assert.equal(calls.length, 0);
});

test("an unbound or missing key is refused before any upload", async () => {
	seed(CUSTOM);
	const record = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
	record.customProvider.credentialBindingId = "0".repeat(32); // nonce no longer matches auth.json
	fs.writeFileSync(settingsFile, JSON.stringify(record));
	const unbound = await post();
	assert.equal(unbound.status, 503);
	assert.equal((await unbound.json()).code, "no-endpoint");
	seed(CUSTOM, ENDPOINT, null);
	assert.equal((await post()).status, 503, "API-key mode without a key");
	assert.equal(calls.length, 0);
});

test("only same-origin browser requests (or the desktop capability) may spend the key", async () => {
	seed(CUSTOM);
	assert.equal((await post(wav(), {})).status, 403);
	assert.equal((await post(wav(), { origin: "https://evil.example" })).status, 403);
	assert.equal(calls.length, 0);
});

test("readiness answers a real browser's same-origin GET, which carries no Origin header", async () => {
	seed(CUSTOM);
	const res = await ready();
	assert.equal(res.status, 200);
	const body = await res.text();
	assert.deepEqual(JSON.parse(body), { ready: true });
	assert.ok(!body.includes(SECRET), "a read never reveals the key");
	assert.equal(calls.length, 0, "a read never calls the endpoint");
});

test("oversized and empty recordings are rejected without an upstream call", async () => {
	seed(CUSTOM);
	const big = await post(new Uint8Array(16), { ...origin, "content-length": String(TRANSCRIBE_MAX_BODY_BYTES + 1) });
	assert.equal(big.status, 413);
	assert.equal((await post(new Uint8Array(44))).status, 400);
	assert.equal(calls.length, 0);
});

test("upstream failures become short lines; the raw body and key never leak", async () => {
	seed(CUSTOM);
	upstream = () => new Response(`CUDA failed with error out of memory; key=${SECRET}`, { status: 500 });
	const failed = await post();
	assert.equal(failed.status, 502);
	const body = await failed.text();
	assert.deepEqual(JSON.parse(body), { message: "Transcription failed (HTTP 500)" });
	assert.ok(!body.includes(SECRET) && !body.includes("CUDA"));
	upstream = () => new Response(null, { status: 307, headers: { location: "http://elsewhere/" } });
	assert.deepEqual(await (await post()).json(), { message: "Transcription redirects are not allowed" });
	upstream = () => Response.json({ nope: true });
	assert.deepEqual(await (await post()).json(), { message: "Transcription returned no text" });
	upstream = () => { throw new TypeError("fetch failed"); };
	assert.deepEqual(await (await post()).json(), { message: "Custom endpoint unreachable" });
});
