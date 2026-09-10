/**
 * Preview-mode document composition: the evaluated HTML fragment from
 * `notist/renderDocument` is placed into a same-origin srcdoc iframe that
 * mirrors the preview site's minimal page shell (`<article
 * class="notist-document">` inside the site stylesheet), so what the editor
 * preview shows is literally what `notist build`/`notist preview` produce.
 *
 * Fragment URLs are site-structure-relative (`../dir/module/`, resources as
 * `../dir/name.png` from the href rules in notist-service request.rs);
 * `rewritePreviewLinks` maps them onto vault files at load time. Pure data —
 * vault/LSP access stays in the shell (notist-view.ts / main.ts).
 */
import type { LspRenderDocumentResult, LspRenderedResource } from "./lsp/protocol";

/** Vendored site assets (assets/site/, refreshed by `bun run assets:site`). */
export interface SiteAssets {
	/** The full site stylesheet (`_notist/style.css`). */
	styleCss: string;
	/** Entry web-component modules (first plugin directory level), keyed by
	 * site-root-relative path. */
	pluginScripts: { name: string; source: string }[];
	/** Every plugin JS file at any depth, keyed site-root-relative — the
	 * import-graph nodes the blob-module rewriter links against. */
	pluginModules: { path: string; source: string }[];
	/** Plugin web-component stylesheets (first directory level, inlined). */
	pluginStyles: { name: string; source: string }[];
	/** Binary plugin assets (wasm/fonts), site-root-relative path → blob URL
	 * created in the app world. Components read the map via
	 * `globalThis.__NOTIST_ASSET_URLS__`; blob URLs stay valid inside the
	 * same-origin srcdoc iframe. */
	pluginAssets: { path: string; blobUrl: string }[];
}

/** The marker class the renderer puts on every plugin web component; its
 * presence in a fragment decides whether component modules load at all. */
const WEB_COMPONENT_CLASS = "notist-web-component";

/** Virtual base substituted for `import.meta.url` inside blob modules:
 * `new URL(rel, import.meta.url)` in vendored code must not throw on a
 * blob: base (opaque path), and the resolved URL is never fetched because
 * components hand wasm bytes over explicitly. */
const VIRTUAL_MODULE_BASE = "https://notist.virtual/";

/** Blob URLs for rewritten plugin modules, cached across renders (creating a
 * fresh URL per render would leak objects until the app dies). */
const moduleBlobUrls = new Map<string, string>();

/** Modules whose blob URL is currently being computed — cycle detection. */
const moduleInFlight = new Set<string>();

/** Resolves a relative ESM specifier against a site-root-relative module
 * path, normalizing `./` and `../` segments. */
export function resolveRelativeModulePath(fromPath: string, specifier: string): string {
	const fromSegments = fromPath.split("/").slice(0, -1);
	const segments = specifier.split("/");
	for (const segment of segments) {
		if (segment === "." || segment === "") continue;
		if (segment === "..") fromSegments.pop();
		else fromSegments.push(segment);
	}
	return fromSegments.join("/");
}

/** Rewrites one plugin module's source for the blob: context: relative
 * static/dynamic import specifiers become absolute blob URLs via `resolveUrl`,
 * and `import.meta.url` becomes the virtual base literal. */
export function rewriteBlobModuleSource(
	path: string,
	source: string,
	resolveUrl: (fromPath: string, specifier: string) => string,
): string {
	let rewritten = source.replace(
		/(\bfrom\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g,
		(_match, head: string, quote: string, specifier: string) =>
			`${head}${quote}${resolveUrl(path, specifier)}${quote}`,
	);
	rewritten = rewritten.replace(
		/\bimport\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/g,
		(_match, quote: string, specifier: string) =>
			`import(${quote}${resolveUrl(path, specifier)}${quote})`,
	);
	return rewritten.replace(/import\.meta\.url/g, JSON.stringify(VIRTUAL_MODULE_BASE + path));
}

/** Blob URL for a plugin module, rewriting its import graph transitively. */
function moduleBlobUrl(modules: Map<string, string>, path: string): string {
	const cached = moduleBlobUrls.get(path);
	if (cached) return cached;
	if (moduleInFlight.has(path)) {
		throw new Error(`import cycle in plugin modules: ${[...moduleInFlight, path].join(" -> ")}`);
	}
	const source = modules.get(path);
	if (source === undefined) throw new Error(`plugin module not found: ${path}`);
	moduleInFlight.add(path);
	try {
		const rewritten = rewriteBlobModuleSource(path, source, (fromPath, specifier) =>
			moduleBlobUrl(modules, resolveRelativeModulePath(fromPath, specifier)),
		);
		const url = URL.createObjectURL(new Blob([rewritten], { type: "text/javascript" }));
		moduleBlobUrls.set(path, url);
		return url;
	} finally {
		moduleInFlight.delete(path);
	}
}

/** Attribute-escaped text for embedding in generated HTML. */
function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Composes the full iframe document. `theme` carries Obsidian's theme
 * classes (`theme-dark`/`theme-light`); `pluginAssetsNeeded` skips the
 * component modules entirely for component-free fragments (plugin modules
 * and their wasm are far too large to load speculatively). */
export function composePreviewDocument(
	result: LspRenderDocumentResult,
	assets: SiteAssets,
	theme: string,
	pluginAssetsNeeded: boolean,
): string {
	let scripts = "";
	let styles = "";
	let assetMap = "";
	if (pluginAssetsNeeded) {
		const modules = new Map(assets.pluginModules.map((module) => [module.path, module.source]));
		scripts = assets.pluginScripts
			.map((script) => {
				try {
					const url = escapeAttr(moduleBlobUrl(modules, script.name));
					return `<script type="module" src="${url}"></script>`;
				} catch (error) {
					console.error(`Notist: plugin module ${script.name} failed to load`, error);
					return "";
				}
			})
			.filter(Boolean)
			.join("\n");
		styles = assets.pluginStyles.map((style) => `<style>${style.source}</style>`).join("\n");
		if (assets.pluginAssets.length > 0) {
			const entries = Object.fromEntries(
				assets.pluginAssets.map((asset) => [asset.path, asset.blobUrl]),
			);
			assetMap = `<script>window.__NOTIST_ASSET_URLS__ = Object.freeze(${JSON.stringify(entries).replace(/</g, "\\u003c")});</script>`;
		}
	}
	return [
		"<!DOCTYPE html>",
		`<html class="${escapeAttr(theme)}">`,
		"<head>",
		'<meta charset="utf-8">',
		// A srcdoc document inherits the app window's base URI, which would
		// make relative URLs and fragment references resolve against the app
		// shell; pinning the base to the document's own URL keeps both
		// consistent (some SVG embedders assert exactly that).
		'<base href="about:srcdoc">',
		`<style>${assets.styleCss}</style>`,
		// The site reserves a fixed topbar via a narrow-viewport body rule;
		// the editor preview has no topbar.
		"<style>body { padding-top: 0; }</style>",
		styles,
		assetMap,
		"</head>",
		`<body class="${escapeAttr(theme)}">`,
		// The site's own layout wrappers: .page-body carries the insets and
		// centering, .page-main the reading column width (min(100%, 46rem)).
		'<div class="page-body">',
		'<main class="page-main" id="page-content">',
		'<article class="notist-document">',
		result.page.fragment,
		"</article>",
		"</main>",
		"</div>",
		scripts,
		"</body>",
		"</html>",
	].join("\n");
}

/** Whether the fragment references plugin web components. */
export function needsPluginAssets(result: LspRenderDocumentResult): boolean {
	return result.page.fragment.includes(WEB_COMPONENT_CLASS);
}

export interface ResolvedLinkTargets {
	/** Vault resource path (`app://…`) for a resource URL, null when unknown. */
	resource(url: string): string | null;
	/** Vault-relative module path (stem directory form) for a module URL. */
	module(url: string): string | null;
}

function decodeUrl(url: string): { segments: string[]; isModulePage: boolean } | null {
	const withoutHash = url.split("#")[0];
	if (/^(app|https?|data|blob|mailto|file):/i.test(withoutHash)) return null;
	if (withoutHash === "" || withoutHash === "#") return null;
	const isModulePage = withoutHash.endsWith("/");
	const decoded = withoutHash.split("/").filter((segment) => segment !== "");
	try {
		return {
			segments: decoded.map((segment) => decodeURIComponent(segment)),
			isModulePage,
		};
	} catch {
		return null;
	}
}

/** Rewrites media URLs in the loaded iframe document onto vault resource
 * paths and tags module anchors with `data-notist-module` for the click
 * interceptor. Unresolvable URLs are left untouched (dead links, like the
 * site without the target page). */
export function rewritePreviewLinks(
	doc: Document,
	result: LspRenderDocumentResult,
	resolveResourcePath: (resource: LspRenderedResource) => string | null,
	resolveModuleDir: (segments: string[]) => string | null,
): void {
	const resourceIndex = new Map<string, LspRenderedResource>();
	for (const resource of result.resources) {
		resourceIndex.set([...resource.moduleSegments, resource.name].join("/"), resource);
	}

	const rewriteAttribute = (el: Element, attr: string): void => {
		const url = el.getAttribute(attr);
		if (!url) return;
		const decoded = decodeUrl(url);
		if (!decoded) return;
		if (decoded.isModulePage) {
			const dir = resolveModuleDir(decoded.segments);
			if (dir !== null) el.setAttribute("data-notist-module", dir);
			return;
		}
		const name = decoded.segments.pop();
		if (name === undefined) return;
		const resource = resourceIndex.get([...decoded.segments, name].join("/"));
		if (!resource) return;
		const path = resolveResourcePath(resource);
		if (path !== null) el.setAttribute(attr, path);
	};

	for (const el of Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"))) {
		rewriteAttribute(el, "src");
	}
	for (const el of Array.from(doc.querySelectorAll("video[src], audio[src], source[src], source[srcset], img[srcset]"))) {
		rewriteAttribute(el, "src");
	}
	// Anchors: media files become app:// URLs; module pages get tagged.
	for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
		const href = anchor.getAttribute("href") ?? "";
		const decoded = decodeUrl(href);
		if (!decoded) continue;
		if (decoded.isModulePage) {
			const dir = resolveModuleDir(decoded.segments);
			if (dir !== null) anchor.setAttribute("data-notist-module", dir);
		} else {
			rewriteAttribute(anchor, "href");
		}
	}
}
