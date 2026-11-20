/**
 * Custom-engine dictation: one recorded run (a 16 kHz mono WAV) goes to the
 * custom OpenAI-compatible endpoint's /audio/transcriptions — e.g. Speaches
 * behind LiteLLM as `whisper-1` — with the endpoint's own bound credential.
 *
 * The renderer never holds the key: it posts the WAV here, this route
 * resolves the custom endpoint exactly as the model registry does (URL,
 * mode and binding must match before any key is read; keyless never reads
 * one), forwards a multipart upload, and returns `{ text }`. Errors are
 * short client-safe lines: never the key, never the raw upstream body.
 *
 * GET is the start-of-run readiness check (the custom engine's stand-in for
 * Deepgram's token mint): it fails fast, before the learner talks for
 * minutes into a run that cannot be transcribed.
 */
import { MAX_IMPORT_BODY_BYTES } from "../../lib/notes-import-limits.ts";
import { whisperLanguage } from "../core/dictation.ts";
import { customBindingMatches } from "../core/custom-provider-auth.ts";
import { customProviderUsable, FACTORY_SETTINGS, type CustomProviderSettings } from "../core/settings.ts";
import { readSettings } from "../store/settings.ts";
import { customAuthState, customKeyAuthorized } from "./custom-provider-auth.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { trustedSameOriginRequest } from "./trusted-request.ts";

/** The proxy's own request buffer: a 12-minute run (~23 MB) fits. */
export const TRANSCRIBE_MAX_BODY_BYTES = MAX_IMPORT_BODY_BYTES;
/** A Whisper cold load onto the GPU plus a 12-minute clip. */
export const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000;
const RESPONSE_MAX_BYTES = 1024 * 1024;

/** Machine-readable reasons the client turns into its own short lines. */
export type TranscribeErrorCode = "engine" | "no-endpoint" | "no-model";

const failure = (message: string, status: number, code?: TranscribeErrorCode) =>
	Response.json(code ? { message, code } : { message }, { status, headers: { "cache-control": "no-store" } });

type Ready =
	| { ok: true; url: string; model: string; language?: string; key?: string }
	| { ok: false; response: Response };

/** Settings + credential resolution, identical to the registry's gate
 * (installCustomProviderSource): binding first, key second. */
function resolveTarget(): Ready {
	const record = readSettings();
	const dictation = record?.dictation;
	if ((dictation?.engine ?? FACTORY_SETTINGS.dictation.engine) !== "custom") {
		return { ok: false, response: failure("Dictation is not set to the custom endpoint", 409, "engine") };
	}
	const cp: CustomProviderSettings | undefined = record?.customProvider;
	if (!customProviderUsable(cp)) {
		return { ok: false, response: failure("Dictation needs a custom endpoint", 503, "no-endpoint") };
	}
	const auth = customAuthState(cp.authMode === "apiKey", cp);
	const ready = auth.readable && customBindingMatches(cp, auth.binding) &&
		(cp.authMode === "keyless" || customKeyAuthorized(cp, auth));
	if (!ready) {
		return { ok: false, response: failure("Reconnect the custom endpoint in Settings to use dictation", 503, "no-endpoint") };
	}
	if (!dictation?.model) {
		return { ok: false, response: failure("Pick a transcription model", 400, "no-model") };
	}
	return {
		ok: true,
		url: `${cp.baseUrl}/audio/transcriptions`,
		model: dictation.model,
		language: whisperLanguage(dictation.language ?? FACTORY_SETTINGS.dictation.language),
		key: cp.authMode === "apiKey" ? auth.key : undefined,
	};
}

/** GET: can a run start? `{ ready: true }` or the same failure the POST would give.
 * A read, like GET /api/custom-provider: no same-origin gate, because browsers
 * send no Origin header on a same-origin GET (the gate refused every real
 * click). It reports configuration state only — the key never leaves this
 * process and the endpoint is not called. The POST, which spends the key,
 * keeps the gate. Desktop requests still pass the proxy's capability check. */
export function transcribeReadiness(): Response {
	const target = resolveTarget();
	return target.ok ? Response.json({ ready: true }, { headers: { "cache-control": "no-store" } }) : target.response;
}

/** The WAV body, byte-bounded while it streams (content-length can lie). */
async function readBoundedBytes(request: Request, limit: number): Promise<Uint8Array> {
	if (Number(request.headers.get("content-length")) > limit) {
		await request.body?.cancel();
		throw new CustomBodyLimitError("Recording is too large to transcribe");
	}
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) throw new CustomBodyLimitError("Recording is too large to transcribe");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const out = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** POST: body = the run's WAV → `{ text }`. */
export async function transcribeRequest(request: Request): Promise<Response> {
	if (!trustedSameOriginRequest(request)) return failure("Dictation requires a trusted same-origin request.", 403);
	const target = resolveTarget();
	if (!target.ok) {
		await request.body?.cancel().catch(() => undefined);
		return target.response;
	}

	let audio: Uint8Array;
	try {
		audio = await readBoundedBytes(request, TRANSCRIBE_MAX_BODY_BYTES);
	} catch (err) {
		if (err instanceof CustomBodyLimitError) return failure(err.message, 413);
		return failure("Recording upload was interrupted", 400);
	}
	if (audio.byteLength <= 44) return failure("Recording is empty", 400);

	const form = new FormData();
	form.append("file", new Blob([audio as BlobPart], { type: "audio/wav" }), "audio.wav");
	form.append("model", target.model);
	if (target.language) form.append("language", target.language);
	form.append("response_format", "json");

	const timeout = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS);
	try {
		const res = await fetch(target.url, {
			method: "POST",
			headers: target.key ? { authorization: `Bearer ${target.key}` } : {},
			body: form,
			redirect: "manual",
			// The learner's cancel (Esc) drops the upstream call too.
			signal: AbortSignal.any([timeout, request.signal]),
		});
		if (res.status >= 300 && res.status < 400) {
			await res.body?.cancel();
			return failure("Transcription redirects are not allowed", 502);
		}
		if (!res.ok) {
			await res.body?.cancel();
			return failure(`Transcription failed (HTTP ${res.status})`, 502);
		}
		const body = await readBoundedJson(res, RESPONSE_MAX_BYTES);
		const text = body !== null && typeof body === "object" ? (body as { text?: unknown }).text : undefined;
		if (typeof text !== "string") return failure("Transcription returned no text", 502);
		return Response.json({ text: text.trim() }, { headers: { "cache-control": "no-store" } });
	} catch {
		if (timeout.aborted) return failure("Transcription timed out", 504);
		if (request.signal.aborted) return failure("Transcription cancelled", 499);
		return failure("Custom endpoint unreachable", 502);
	}
}
