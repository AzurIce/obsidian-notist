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
	/** Plugin web-component module sources (loaded as blob module scripts). */
	pluginScripts: { name: string; source: string }[];
	/** Plugin web-component stylesheets (inlined). */
	pluginStyles: { name: string; source: string }[];
}

/** The marker class the renderer puts on every plugin web component; its
 * presence in a fragment decides whether component modules load at all. */
const WEB_COMPONENT_CLASS = "notist-web-component";

/** Blob URLs for plugin module sources, cached across renders (creating a
 * fresh URL per render would leak objects until the document dies). */
const scriptBlobUrls = new Map<string, string>();

function scriptBlobUrl(name: string, source: string): string {
	let url = scriptBlobUrls.get(name);
	if (!url) {
		url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
		scriptBlobUrls.set(name, url);
	}
	return url;
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
 * component modules entirely for component-free fragments (mermaid.js is
 * far too large to load speculatively). */
export function composePreviewDocument(
	result: LspRenderDocumentResult,
	assets: SiteAssets,
	theme: string,
	pluginAssetsNeeded: boolean,
): string {
	const scripts = pluginAssetsNeeded
		? assets.pluginScripts
			.map((script) => {
				const url = escapeAttr(scriptBlobUrl(script.name, script.source));
				return `<script type="module" src="${url}"></script>`;
			})
			.join("\n")
		: "";
	const styles = pluginAssetsNeeded
		? assets.pluginStyles
			.map((style) => `<style>${style.source}</style>`)
			.join("\n")
		: "";
	return [
		"<!DOCTYPE html>",
		`<html class="${escapeAttr(theme)}">`,
		"<head>",
		'<meta charset="utf-8">',
		`<style>${assets.styleCss}</style>`,
		// The site reserves a fixed topbar via a narrow-viewport body rule;
		// the editor preview has no topbar.
		"<style>body { padding-top: 0; }</style>",
		styles,
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
