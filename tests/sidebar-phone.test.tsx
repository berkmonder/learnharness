/**
 * The phone drawer (owner, 2026-11-21): below 640px the sidebar is a
 * slide-over drawer — it starts closed whatever the desktop preference
 * says, never writes that preference, and closes on its backdrop, on Esc,
 * on navigation and when Settings opens. At 640px and up the inline
 * sidebar keeps its persisted behavior. Mounted for real (linkedom), with
 * the App Router's two contexts provided by hand and matchMedia stubbed.
 */
import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const aside = () => byTest("sessions-sidebar")!;
const isOpen = () => aside().getAttribute("aria-hidden") === "false";
const backdropShown = () => byTest("sidebar-backdrop")!.className.includes("opacity-100");

async function fixture({ phone, stored }: { phone: boolean; stored: string | null }) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(win, { innerWidth: phone ? 390 : 1280, innerHeight: 844 });
	const store = new Map<string, string>(stored === null ? [] : [["lh:sidebar-open", stored]]);
	const writes: [string, string][] = [];
	const localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => { writes.push([key, value]); store.set(key, value); },
		removeItem: (key: string) => { store.delete(key); },
	};
	Object.assign(win, {
		localStorage,
		matchMedia: (query: string) => ({ matches: phone, media: query, addEventListener() {}, removeEventListener() {} }),
	});
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, self: win, document: doc, localStorage, navigator: { userAgent: "test" },
		Element: win.Element, HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement,
		Node: win.Node, Event: win.Event, CustomEvent: win.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		fetch: async (url: string) => {
			if (url === "/api/chats") return Response.json({ chats: [] });
			if (url === "/api/settings") return Response.json({ settings: null });
			return Response.json({});
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
	const { AppShell, SidebarProvider, SidebarToggle } = await import("../components/sidebar.tsx");
	const { ServerEventsProvider } = await import("../components/server-events.tsx");
	const quietChannel = () => ({ close() {}, onOpen() {}, onEvent() {} });
	const noop = () => {};
	const router = { back: noop, forward: noop, refresh: noop, hmrRefresh: noop, push: noop, replace: noop, prefetch: noop };
	let navigate: (path: string) => void = noop;
	function Harness() {
		const [path, setPath] = useState("/");
		navigate = setPath;
		return (
			<AppRouterContext.Provider value={router as never}>
				<PathnameContext.Provider value={path}>
					<ServerEventsProvider connect={quietChannel}>
						<SidebarProvider>
							<AppShell>
								<SidebarToggle />
							</AppShell>
						</SidebarProvider>
					</ServerEventsProvider>
				</PathnameContext.Provider>
			</AppRouterContext.Provider>
		);
	}
	const root = createRoot(doc.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	const click = async (el: HTMLElement) => {
		await act(async () => { el.dispatchEvent(new win.Event("click", { bubbles: true })); });
	};
	const openToggle = () => doc.querySelector<HTMLElement>('button[aria-label="Open sidebar"]')!;
	return {
		writes,
		click,
		openToggle,
		navigate: async (path: string) => { await act(async () => { navigate(path); }); },
		esc: async () => {
			// linkedom has no KeyboardEvent: a keydown Event carrying the key.
			const event = new win.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: "Escape" });
			await act(async () => { doc.dispatchEvent(event); });
			return event;
		},
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("phone: starts closed even when the desktop preference says open, and never writes it", async () => {
	const f = await fixture({ phone: true, stored: "1" });
	assert.equal(isOpen(), false);
	assert.match(aside().className, /max-sm:-translate-x-full/);
	assert.equal(backdropShown(), false);
	await f.click(f.openToggle());
	assert.equal(isOpen(), true);
	assert.doesNotMatch(aside().className, /max-sm:-translate-x-full/);
	assert.equal(backdropShown(), true);
	await f.click(byTest("sidebar-backdrop")!);
	assert.equal(isOpen(), false);
	assert.deepEqual(f.writes, [], "the drawer's state is its own");
});

test("phone: the drawer closes on navigation, on Esc, and when Settings opens", async () => {
	const f = await fixture({ phone: true, stored: null });
	await f.click(f.openToggle());
	assert.equal(isOpen(), true);
	await f.navigate("/chat/new");
	assert.equal(isOpen(), false, "navigation closes it");

	await f.click(f.openToggle());
	const esc = await f.esc();
	assert.equal(isOpen(), false, "Esc closes it");
	assert.equal(esc.defaultPrevented, true, "the drawer claims its Esc (the one-Esc law)");

	await f.click(f.openToggle());
	await f.click(byTest("settings-entry")!);
	assert.equal(isOpen(), false, "Settings closes it");
	assert.ok(byTest("settings-dialog"), "and the dialog opens");
});

test("phone: the toggle keeps its slot while the drawer is open (no header shift)", async () => {
	const f = await fixture({ phone: true, stored: null });
	await f.click(f.openToggle());
	assert.equal(isOpen(), true);
	assert.match(f.openToggle().closest("span")!.className, /\bw-9\b/, "the slot stays 36px");
	assert.doesNotMatch(f.openToggle().closest("span")!.className, /\bw-0\b/);
});

test("desktop: the inline sidebar keeps the persisted preference and no backdrop shows", async () => {
	const f = await fixture({ phone: false, stored: "1" });
	assert.equal(isOpen(), true, "stored open = open");
	assert.equal(backdropShown(), false);
	assert.match(byTest("sidebar-backdrop")!.className, /sm:hidden/);
	await f.click(document.querySelector<HTMLElement>('button[aria-label="Close sidebar"]')!);
	assert.equal(isOpen(), false);
	assert.deepEqual(f.writes, [["lh:sidebar-open", "0"]]);
	await f.navigate("/chat/new");
	await f.click(f.openToggle());
	assert.equal(isOpen(), true, "navigation never closes the desktop sidebar");
	assert.deepEqual(f.writes.at(-1), ["lh:sidebar-open", "1"]);
});
