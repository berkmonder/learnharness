"use client";

import { DICTATION_ENGINES, FACTORY_SETTINGS, isDictationEngine, type CustomModel } from "@/src/core";
import { SettingsRow, ThinSelect } from "@/components/settings/controls";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationPreference } from "@/components/dictation-preference";

/** Settings → Providers → Dictation → Engine: Deepgram streams; Custom
 * endpoint uploads each run to the custom endpoint's /audio/transcriptions.
 * Locked while a run is live, like the Language row. */
export function DictationEngineSetting() {
	const { engine, saving, error, saveEngine } = useDictationPreference();
	const active = useDictationActive();
	const loaded = engine !== undefined;
	return (
		<SettingsRow
			label="Engine"
			testid="row-dictation-engine"
			dimmed={active}
			hint={error ? <span role="alert" className="text-destructive">{error}</span> : undefined}
		>
			<ThinSelect
				value={engine ?? FACTORY_SETTINGS.dictation.engine}
				onChange={(next) => { if (isDictationEngine(next)) void saveEngine(next); }}
				ariaLabel="Dictation engine"
				testid="dictation-engine"
				disabled={active || saving || !loaded}
			>
				{DICTATION_ENGINES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
			</ThinSelect>
		</SettingsRow>
	);
}

/** Settings → Providers → Dictation → Model (custom engine only): one of the
 * custom endpoint's models, e.g. LiteLLM's whisper-1. No preselection. */
export function DictationModelSetting({ baseUrl, models }: {
	/** The custom endpoint's URL; empty/undefined = none configured. */
	baseUrl: string | undefined;
	models: readonly CustomModel[] | undefined;
}) {
	const { model, saving, saveModel, engine } = useDictationPreference();
	const active = useDictationActive();
	if (!baseUrl) {
		return (
			<SettingsRow label="Model" testid="row-dictation-model" dimmed>
				<span data-testid="dictation-model-missing" className="text-xs text-muted-foreground/70">
					Add a custom endpoint first
				</span>
			</SettingsRow>
		);
	}
	const ids = (models ?? []).map(({ id }) => id);
	// A saved id the endpoint no longer lists stays visible rather than
	// silently showing another model as selected.
	if (model && !ids.includes(model)) ids.unshift(model);
	return (
		<SettingsRow label="Model" hint={`From ${baseUrl}`} testid="row-dictation-model" dimmed={active}>
			<ThinSelect
				value={model ?? ""}
				onChange={(next) => { if (next) void saveModel(next); }}
				ariaLabel="Dictation transcription model"
				testid="dictation-model"
				disabled={active || saving || engine === undefined}
			>
				{!model && <option value="" disabled>Pick a model</option>}
				{ids.map((id) => <option key={id} value={id}>{id}</option>)}
			</ThinSelect>
		</SettingsRow>
	);
}
