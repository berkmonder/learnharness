/** The trust gate for routes that spend the custom endpoint's credential
 * (custom-endpoint configuration, custom-engine dictation). */
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

/** Desktop capability, or a same-origin browser request. Shared by every
 * route that spends the custom endpoint's credential (custom-engine
 * dictation included). */
export function trustedSameOriginRequest(request: Request): boolean {
	const desktop = process.env.LH_DESKTOP_SERVER === "1" || Boolean(process.env.LH_DESKTOP_API_SECRET);
	if (desktop) return desktopAPIAuthorized(request.headers);
	const origin = request.headers.get("origin");
	if (!origin || origin === "null") return false;
	try {
		// Next's standalone Request URL can use its internal hostname. Match
		// the actual addressed Host through the app's existing origin seam;
		// never trust forwarded-origin headers.
		return origin === subscriptionRequestOrigin(request)
			&& (!request.headers.has("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
	} catch { return false; }
}
