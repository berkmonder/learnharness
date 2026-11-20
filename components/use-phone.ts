"use client";

import { useSyncExternalStore } from "react";

/**
 * THE PHONE LAYOUT (owner, 2026-11-21): below 640px — Tailwind's `sm`
 * breakpoint — the app takes its phone layout. CSS carries most of it
 * (base/`max-sm:` classes vs `sm:`); this is the JS side for the few
 * behaviors that need to know (the sidebar drawer). The Electron window
 * floor is 640px, so the desktop app never matches.
 *
 * Server and hydration render as desktop (false); the client snapshot
 * applies right after hydration.
 */
export const PHONE_QUERY = "(max-width: 639.98px)";

function query(): MediaQueryList | null {
	return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;
}

function subscribe(listener: () => void): () => void {
	const mql = query();
	if (!mql) return () => {};
	mql.addEventListener("change", listener);
	return () => mql.removeEventListener("change", listener);
}

export function isPhone(): boolean {
	return query()?.matches ?? false;
}

export function usePhone(): boolean {
	return useSyncExternalStore(subscribe, isPhone, () => false);
}
