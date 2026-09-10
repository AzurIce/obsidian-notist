import { describe, expect, test } from "bun:test";
import {
	composePreviewDocument,
	needsPluginAssets,
	resolveRelativeModulePath,
	rewriteBlobModuleSource,
} from "./preview";
import type { LspRenderDocumentResult } from "./lsp/protocol";

describe("resolveRelativeModulePath", () => {
	test("sibling specifier", () => {
		expect(resolveRelativeModulePath("plugins/p/entry.js", "./util.js")).toBe(
			"plugins/p/util.js",
		);
	});

	test("parent traversal", () => {
		expect(
			resolveRelativeModulePath(
				"plugins/mermaid/merman-web-render/dist/package-entries/render.js",
				"../../artifacts/wasm/merman_wasm.js",
			),
		).toBe("plugins/mermaid/merman-web-render/artifacts/wasm/merman_wasm.js");
	});
});

describe("rewriteBlobModuleSource", () => {
	const resolveUrl = (_from: string, spec: string) => `blob:resolved(${spec})`;

	test("static import", () => {
		expect(
			rewriteBlobModuleSource("p/a.js", `import { x } from './b.js';\n`, resolveUrl),
		).toBe(`import { x } from 'blob:resolved(./b.js)';\n`);
	});

	test("export-from style re-export keeps working via from", () => {
		expect(
			rewriteBlobModuleSource("p/a.js", `export { y } from "../nested/b.js";\n`, resolveUrl),
		).toBe(`export { y } from "blob:resolved(../nested/b.js)";\n`);
	});

	test("dynamic import", () => {
		expect(
			rewriteBlobModuleSource(
				"p/dist/entry.js",
				`const m = await import("../wasm/glue.js");\n`,
				resolveUrl,
			),
		).toBe(`const m = await import("blob:resolved(../wasm/glue.js)");\n`);
	});

	test("bare specifier untouched", () => {
		const source = `import { init } from "external-pkg";\n`;
		expect(rewriteBlobModuleSource("p/a.js", source, resolveUrl)).toBe(source);
	});

	test("import.meta.url becomes virtual base literal", () => {
		const rewritten = rewriteBlobModuleSource(
			"p/dist/render.js",
			`const url = new URL("../wasm/x.wasm", import.meta.url);`,
			resolveUrl,
		);
		expect(rewritten).toBe(
			`const url = new URL("../wasm/x.wasm", "https://notist.virtual/p/dist/render.js");`,
		);
	});
});

describe("composePreviewDocument", () => {
	const result = {
		page: { fragment: "<p>hi</p>" },
		resources: [],
	} as unknown as LspRenderDocumentResult;

	const assets = {
		styleCss: "body {}",
		pluginScripts: [{ name: "plugins/p/entry.js", source: `import './lib.js';` }],
		pluginModules: [
			{ path: "plugins/p/entry.js", source: `import './lib.js';` },
			{ path: "plugins/p/lib.js", source: `export const x = 1;` },
		],
		pluginStyles: [{ name: "plugins/p/style.css", source: ".x {}" }],
		pluginAssets: [{ path: "plugins/p/a.wasm", blobUrl: "blob:wasmurl" }],
	};

	test("injects rewritten entry module, styles and asset map", () => {
		const html = composePreviewDocument(result, assets, "theme-dark", true);
		expect(html).toContain('src="blob:');
		expect(html).not.toContain("./lib.js");
		expect(html).toContain("<style>.x {}</style>");
		expect(html).toContain(`window.__NOTIST_ASSET_URLS__`);
		expect(html).toContain("blob:wasmurl");
	});

	test("skips plugin assets for component-free fragments", () => {
		const html = composePreviewDocument(result, assets, "", false);
		expect(html).not.toContain("blob:");
		expect(html).not.toContain("__NOTIST_ASSET_URLS__");
		expect(html).toContain("<p>hi</p>");
	});

	test("needsPluginAssets keys on the marker class", () => {
		expect(needsPluginAssets(result)).toBe(false);
		expect(
			needsPluginAssets({
				page: { fragment: `<div class="${"notist-web-component"}"></div>` },
				resources: [],
			} as unknown as LspRenderDocumentResult),
		).toBe(true);
	});
});
