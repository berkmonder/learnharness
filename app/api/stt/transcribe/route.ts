/**
 * Custom-engine dictation (see src/server/transcribe.ts): GET checks a run
 * can start; POST takes the run's WAV and returns `{ text }` from the custom
 * endpoint's /audio/transcriptions. The key stays server-side.
 */
import { transcribeReadiness, transcribeRequest } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = transcribeReadiness;
export const POST = transcribeRequest;
