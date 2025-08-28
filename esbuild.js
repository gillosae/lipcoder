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
                
                let orig = fs.readFileSync(outFile, 'utf8');
                let hasChanges = false;
                
                if (orig.includes('node:')) {
                    // 더 포괄적인 node: prefix 제거
                    const patterns = [
                        // require() 패턴들
                        /require\(["']node:([^"']+)["']\)/g,
                        /require\(["']node:([^"']+)\/([^"']+)["']\)/g,
                        
                        // import/from 패턴들  
                        /from ["']node:([^"']+)["']/g,
                        /from ["']node:([^"']+)\/([^"']+)["']/g,
                        /import ["']node:([^"']+)["']/g,
                        /import ["']node:([^"']+)\/([^"']+)["']/g,
                        
                        // 동적 import 패턴들
                        /import\(["']node:([^"']+)["']\)/g,
                        /import\(["']node:([^"']+)\/([^"']+)["']\)/g,
                    ];
                    
                    patterns.forEach(pattern => {
                        const newContent = orig.replace(pattern, (match, module, submodule) => {
                            if (submodule) {
                                // node:module/submodule -> module/submodule
                                return match.replace(`node:${module}/${submodule}`, `${module}/${submodule}`);
                            } else {
                                // node:module -> module
                                return match.replace(`node:${module}`, module);
                            }
                        });
                        
                        if (newContent !== orig) {
                            orig = newContent;
                            hasChanges = true;
                        }
                    });
                    
                    // 추가적인 안전 처리: 남은 node: 패턴들 제거
                    const additionalPatterns = [
                        /["']node:internal\/([^"']+)["']/g,
                        /["']node:([^"'\/]+)["']/g,
                    ];
                    
                    additionalPatterns.forEach(pattern => {
                        const newContent = orig.replace(pattern, (match, module) => {
                            return match.replace(/node:/, '');
                        });
                        
                        if (newContent !== orig) {
                            orig = newContent;
                            hasChanges = true;
                        }
                    });
                    
                    if (hasChanges) {
                        fs.writeFileSync(outFile, orig, 'utf8');
                        console.log('[postprocess] ✅ Stripped node: prefixes from bundled output');
                        
                        // 처리된 패턴들 로그
                        const remainingNodeRefs = (orig.match(/node:/g) || []).length;
                        if (remainingNodeRefs > 0) {
                            console.warn(`[postprocess] ⚠️  ${remainingNodeRefs} node: references still remain`);
                        }
                    }
                }
            } catch (e) {
                console.error('[postprocess] ❌ Failed to strip node: prefixes:', e && e.message);
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
		external: ['vscode', 'node-pty', 'node-pty-prebuilt-multiarch', 'speaker'],
		logLevel: 'silent',
		define: {
			'process.env.NODE_ENV': production ? '"production"' : '"development"'
		},
		// Node.js 내장 모듈들을 올바르게 처리
		alias: {
			'node:child_process': 'child_process',
			'node:fs': 'fs',
			'node:path': 'path',
			'node:os': 'os',
			'node:util': 'util',
			'node:events': 'events',
			'node:stream': 'stream',
			'node:buffer': 'buffer',
			'node:crypto': 'crypto',
			'node:url': 'url',
			'node:querystring': 'querystring',
			'node:http': 'http',
			'node:https': 'https',
			'node:net': 'net',
			'node:tls': 'tls',
			'node:zlib': 'zlib',
			'node:readline': 'readline',
			'node:process': 'process',
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
