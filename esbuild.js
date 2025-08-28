const esbuild = require("esbuild");
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * Post-process bundled output to strip "node:" prefixes in core module imports.
 * This avoids extension-host issues resolving module roots from node:internal/* frames.
 */
const postProcessNodePrefixPlugin = {
    name: 'postprocess-node-prefix',
    setup(build) {
        build.onEnd((result) => {
            try {
                const outFile = path.resolve(process.cwd(), 'dist/client/extension.js');
                if (!fs.existsSync(outFile)) return;
                const orig = fs.readFileSync(outFile, 'utf8');
                if (orig.includes('node:')) {
                    const replaced = orig
                        .replace(/require\(["']node:/g, 'require("')
                        .replace(/from ["']node:/g, 'from "');
                    fs.writeFileSync(outFile, replaced, 'utf8');
                    console.log('[postprocess] stripped node: prefixes in bundled output');
                }
            } catch (e) {
                console.warn('[postprocess] failed to strip node: prefixes:', e && e.message);
            }
        });
    }
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'client/src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: false,
		sourcesContent: false,
		platform: 'node',
		target: 'node18',
		outfile: 'dist/client/extension.js',
		external: ['vscode', 'node-pty', 'node-pty-prebuilt-multiarch'],
		logLevel: 'silent',
		define: {
			'process.env.NODE_ENV': production ? '"production"' : '"development"'
		},
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
			postProcessNodePrefixPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
