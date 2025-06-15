import * as wav from 'wav';
import { specialWordCache } from './audio';
import * as vscode from 'vscode';
import {
	LanguageClient,
	ServerOptions,
	TransportKind,
	LanguageClientOptions
} from 'vscode-languageclient/node';
import * as path from 'path';
import * as fs from 'fs';
import { SymbolInformation } from 'vscode-languageserver-types';
import {
	setBackend,
	TTSBackend,
	speakToken,
	setAudioDirectory,
	genTokenAudio,
	playWave,
	stopPlayback,
	preloadEarcons,
	preloadSpecialWords,
	playSpecial,
	playSequence
} from './audio';
import { lipcoderLog } from './logger';
import { createAudioMap, specialCharMap } from './mapping';

let typingSpeechEnabled = true; // global flag to control typing speech

let playSpeed: number = 1.4; // LipCoder playback speed multiplier (default 1.0×)

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('[extension] activate() called');
	lipcoderLog.appendLine('[extension] activate() called');
	vscode.window.showInformationMessage('LipCoder: activate() called');
	// ── 0) TTS setup ───────────────────────────────────────────────────────────────

	// Dynamically import the ESM word‐list package
	const { default: wordListPath } = await import('word-list');
	// Load dictionary into a Set for fast lookups
	const dictWords = new Set<string>(
		fs.readFileSync(wordListPath, 'utf8')
			.split('\n')
			.map(w => w.toLowerCase())
	);
	function isDictionaryWord(token: string): boolean {
		return dictWords.has(token.toLowerCase());
	}

	// Module-scope controller for cancellation
	let currentAbortController: AbortController | null = null;

	const extRoot = context.extensionPath;
	const audioDir = path.join(extRoot, 'client', 'audio');
	const pythonExe = path.join(extRoot, 'client', 'src', 'python', 'bin', 'python');
	const scriptPath = path.join(extRoot, 'client', 'src', 'python', 'silero_tts_infer.py');

	setAudioDirectory(audioDir);
	// ── DEBUG: verify packaging paths and contents ────────────────────────────
	console.log('[DEBUG] extRoot =', extRoot);
	console.log('[DEBUG] audioDir =', audioDir);
	try {
		const earconFiles = fs.readdirSync(path.join(audioDir, 'earcon'));
		console.log('[DEBUG] earcon files =', earconFiles);
		lipcoderLog.appendLine(`DEBUG: earcon files: ${earconFiles.join(', ')}`);
	} catch (e) {
		console.error('[DEBUG] failed to list earcon:', e);
		lipcoderLog.appendLine(`DEBUG: failed to list earcon: ${e}`);
	}
	['python', 'typescript'].forEach(lang => {
		const dir = path.join(audioDir, lang);
		try {
			const files = fs.readdirSync(dir).filter(f => f.endsWith('.wav'));
			console.log(`[DEBUG] ${lang} WAV files =`, files);
			lipcoderLog.appendLine(`DEBUG: ${lang} WAV files: ${files.join(', ')}`);
		} catch (e) {
			console.error(`[DEBUG] failed to list ${lang} WAVs:`, e);
			lipcoderLog.appendLine(`DEBUG: failed to list ${lang} WAVs: ${e}`);
		}
	});
	// ── end DEBUG ───────────────────────────────────────────────────────────────
	setBackend(TTSBackend.Silero, {
		pythonExe,
		scriptPath,
		language: 'en',
		modelId: 'v3_en',
		defaultSpeaker: 'en_3',
		sampleRate: 24000,
		// gap: 0,
		// speed: 400
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.setPlaySpeed', async () => {
			const input = await vscode.window.showInputBox({
				prompt: 'Set LipCoder playback speed multiplier (e.g., 1.0 = normal, 1.5 = 50% faster)',
				value: playSpeed.toString()
			});
			if (input !== undefined) {
				const val = parseFloat(input);
				if (!isNaN(val) && val > 0) {
					playSpeed = val;
					vscode.window.showInformationMessage(`LipCoder playback speed set to ${val}×`);
				} else {
					vscode.window.showErrorMessage('Invalid playback speed. Enter a positive number.');
				}
			}
		})
	);

	// ── 0.1) Pre-generate earcons into cache ────────────────────────────
	await preloadEarcons();
	lipcoderLog.appendLine('[DEBUG] Starting special-word TTS preload');
	await preloadSpecialWords();
	lipcoderLog.appendLine('[DEBUG] Completed special-word TTS preload');
	// ── 0.2) Preload Python/TS keyword WAVs in batches (non-blocking) ─────────
	await (async () => {
		const keywordDirs = ['python', 'typescript'];
		const concurrency = 5;
		for (const lang of keywordDirs) {
			const dir = path.join(extRoot, 'client', 'audio', lang);
			let files: string[];
			try {
				files = await fs.promises.readdir(dir);
			} catch (e) {
				lipcoderLog.appendLine(`[keyword preload] Failed to read dir ${dir}: ${e}`);
				continue;
			}
			let index = 0;
			async function worker() {
				while (index < files.length) {
					const file = files[index++];
					if (!file.endsWith('.wav')) continue;
					const token = file.replace(/\.wav$/, '');
					const wavPath = path.join(dir, file);
					try {
						const reader = new wav.Reader();
						const bufs: Buffer[] = [];
						let fmt: any;
						reader.on('format', (f: any) => fmt = f);
						reader.on('data', (d: Buffer) => bufs.push(d));
						await new Promise<void>((resolve, reject) => {
							reader.on('end', resolve);
							reader.on('error', reject);
							fs.createReadStream(wavPath).pipe(reader);
						});
						specialWordCache[token] = { format: fmt, pcm: Buffer.concat(bufs) };
					} catch (e) {
						lipcoderLog.appendLine(`[keyword preload] Failed loading ${wavPath}: ${e}`);
					}
				}
			}
			// Launch workers for this language
			Array.from({ length: concurrency }).map(() => worker());
		}
		lipcoderLog.appendLine('[keyword preload] Launched batch keyword WAV preloading');
	})();

	// ── 1) Build the unified audioMap ─────────────────────────────────────────────
	const audioMap = createAudioMap(context);

	function isEarcon(ch: string): boolean {
		// Only punctuation/symbol earcons here—digits (0–9) fall back to 'special'
		return ch.length === 1
			&& audioMap[ch] !== undefined
			&& !/^\d$/.test(ch);
	}
	function isSpecial(ch: string): boolean {
		return ch.length === 1 && specialCharMap[ch] !== undefined;
	}

	// ── 2. Start LanguageClient ──────────────────────────────────────────────────
	const serverModule = context.asAbsolutePath(
		path.join('dist', 'server', 'server.js')
	);
	const serverOpts: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.stdio },
		debug: {
			module: serverModule,
			transport: TransportKind.stdio,
			options: { execArgv: ['--inspect=6009'] },
		},
	};

	const clientOpts: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'javascript' },
			{ scheme: 'file', language: 'typescript' },
			{ scheme: 'file', language: 'python' },
		],
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*'),
		},
	};

	const client = new LanguageClient(
		'lipcoder',
		'LipCoder LSP',
		serverOpts,
		clientOpts
	);
	context.subscriptions.push({
		dispose: () => {
			client.stop();
		},
	});
	client.start();

	// ── 3. Register commands ───────────────────────────────────────────────────────

	// 3.1 echoTest
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.echoTest', async () => {
			try {
				lipcoderLog.appendLine('[echoTest] invoked');
				const res = await client.sendRequest<{ text: string }>(
					'lipcoder/echo',
					{ text: 'hello' }
				);
				lipcoderLog.appendLine(`[echoTest] response: ${res.text}`);
				vscode.window.showInformationMessage(res.text);
			} catch (err) {
				vscode.window.showErrorMessage(`EchoTest failed: ${err}`);
			}
		})
	);

	// 3.2 whereAmI
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.whereAmI', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage('No active editor!');
				return;
			}
			const uri = editor.document.uri.toString();

			try {
				const symbols = await client.sendRequest<SymbolInformation[]>(
					'textDocument/documentSymbol',
					{ textDocument: { uri } }
				);

				const pos = editor.selection.active;
				const containing = symbols
					.filter((s) => {
						const r = s.location.range;
						return (
							(pos.line > r.start.line ||
								(pos.line === r.start.line &&
									pos.character >= r.start.character)) &&
							(pos.line < r.end.line ||
								(pos.line === r.end.line &&
									pos.character <= r.end.character))
						);
					})
					.sort((a, b) => {
						const lenA =
							a.location.range.end.line - a.location.range.start.line;
						const lenB =
							b.location.range.end.line - b.location.range.start.line;
						return lenA - lenB;
					});

				if (containing.length === 0) {
					vscode.window.showInformationMessage('Outside of any symbol.');
					await speakToken('You are outside of any symbol.');
				} else {
					const symbol = containing[0];
					const container = symbol.containerName
						? `${symbol.containerName} → `
						: '';
					const msg = `${container}${symbol.name}`;
					vscode.window.showInformationMessage(`You are in: ${msg}`);
					await speakToken(`You are in ${msg}`);
				}
			} catch (err) {
				vscode.window.showErrorMessage(`whereAmI failed: ${err}`);
			}
		})
	);

	// ── 3.3 readLineTokens (with acronym & digit splitting) ───────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.readLineTokens', async () => {
			// cancel any previous speech
			if (currentAbortController) {
				currentAbortController.abort();
			}
			const controller = new AbortController();
			currentAbortController = controller;
			const { signal } = controller;

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage('No active editor!');
				return;
			}
			const uri = editor.document.uri.toString();
			const line = editor.selection.active.line;

			try {
				// 1) Fetch raw tokens from LSP
				let tokens = await client.sendRequest<
					{ text: string; category: string }[]
				>('lipcoder/readLineTokens', { uri, line });
				vscode.window.showInformationMessage(
					`Read ${tokens.length} tokens from LSP`
				);

				// Remove leading whitespace-only tokens (e.g. space, tab)
				while (tokens.length > 0 && /^\s+$/.test(tokens[0].text)) {
					tokens.shift();
				}

				// Determine file language for keyword audio
				const docLang = editor.document.languageId === 'python' ? 'python' : 'typescript';
				tokens = tokens.map(tok => ({
					text: tok.text,
					category: tok.category === 'keyword' ? `keyword_${docLang}` : tok.category
				}));

				// ── Merge any [word] "_" [word] sequences back into a single token ─────────
				const mergedTokens: typeof tokens = [];
				for (let i = 0; i < tokens.length; i++) {
					const cur = tokens[i];
					if (
						cur.text === '_' &&
						mergedTokens.length > 0 &&
						i + 1 < tokens.length &&
						/^[A-Za-z]+$/.test(mergedTokens[mergedTokens.length - 1].text) &&
						/^[A-Za-z]+$/.test(tokens[i + 1].text)
					) {
						// pull off the last “word” token,
						// glue it to "_" and the next word
						const prev = mergedTokens.pop()!;
						mergedTokens.push({
							text: prev.text + '_' + tokens[i + 1].text,
							category: prev.category
						});
						i++; // skip the next one, since we just merged it
					} else {
						mergedTokens.push(cur);
					}
				}
				tokens = mergedTokens;

				// 2) Build flat action list
				type Action =
					| { kind: 'text'; text: string; category: string }
					| { kind: 'earcon'; token: string; category: string }
					| { kind: 'special'; token: string };

				const actions: Action[] = [];
				let buffer = '';
				let bufferCat: string | null = null;

				function flush() {
					if (!buffer.trim()) {
						buffer = '';
						bufferCat = null;
						return;
					}
					actions.push({ kind: 'text', text: buffer, category: bufferCat! });
					buffer = '';
					bufferCat = null;
				}

				// Helper to split a CamelCase identifier
				function isCamelCase(id: string) {
					return /[a-z][A-Z]/.test(id);
				}
				function splitCamel(id: string): string[] {
					return id.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || [id];
				}

				/**
				 * Split any text token into the same sequence of text/earcon/special
				 * actions you already use for identifiers, numbers, punctuation, etc.
				 */
				function splitToken(text: string, category: string) {
					const twoLenExceptions = new Set(['no', 'is', 'if', 'on', 'in']);
					const threeLenExceptions = new Set(['fmt']);
					// 1) 2-letter words: split unless exception
					if (/^[A-Za-z]{2}$/.test(text)) {
						if (!twoLenExceptions.has(text.toLowerCase())) {
							for (const ch of text) actions.push({ kind: 'text', text: ch, category });
						} else {
							actions.push({ kind: 'text', text, category });
						}
						return;
					}
					// 2) 3-letter words: if in dictionary && not exception, whole; else split
					if (/^[A-Za-z]{3}$/.test(text)) {
						const lower = text.toLowerCase();
						if (isDictionaryWord(text) && !threeLenExceptions.has(lower)) {
							actions.push({ kind: 'text', text, category });
						} else {
							for (const ch of text) actions.push({ kind: 'text', text: ch, category });
						}
						return;
					}
					// ── X) If this token contains any special characters, split and group runs ──
					if (/[\\{},]/.test(text)) {
						let buf = '';
						for (const ch of text) {
							if (/[\\{},]/.test(ch)) {
								// flush buffered text first
								if (buf) {
									actions.push({ kind: 'text', text: buf, category });
									buf = '';
								}
								// emit special or earcon
								if (isEarcon(ch)) {
									actions.push({ kind: 'earcon', token: ch, category });
								} else if (isSpecial(ch)) {
									actions.push({ kind: 'special', token: ch });
								} else {
									actions.push({ kind: 'text', text: ch, category });
								}
							} else {
								buf += ch;
							}
						}
						// flush any remaining buffered text
						if (buf) {
							actions.push({ kind: 'text', text: buf, category });
						}
						return;
					}
					// C) Dictionary words
					if (/^[A-Za-z]+$/.test(text) && isDictionaryWord(text)) {
						actions.push({ kind: 'text', text, category });
						return;
					}

					// UNDERSCORE splitting
					if (text.includes('_')) {
						for (const part of text.split(/(_)/)) {
							if (!part) continue;
							if (part === '_') {
								actions.push({ kind: 'special', token: '_' });
							} else if (part.length <= 2) {
								for (const ch of part) actions.push({ kind: 'text', text: ch, category });
							} else {
								actions.push({ kind: 'text', text: part, category });
							}
						}
						return;
					}

					// Acronym / digit / other-run splitting
					if (/[A-Za-z]/.test(text) && /\d|[^A-Za-z0-9]/.test(text)) {
						for (const run of text.match(/[A-Za-z]+|\d+|[^A-Za-z0-9]+/g)!) {
							if (/^[A-Za-z]+$/.test(run)) {
								const lower = run.toLowerCase();
								if (run.length === 2) {
									// Two-letter run: split unless in exceptions
									if (!twoLenExceptions.has(lower)) {
										for (const ch of run) {
											actions.push({ kind: 'text', text: ch, category });
										}
									} else {
										actions.push({ kind: 'text', text: run, category });
									}
								} else if (run.length === 3) {
									// Three-letter run: keep whole unless in exceptions (in which case split)
									if (threeLenExceptions.has(lower)) {
										for (const ch of run) {
											actions.push({ kind: 'text', text: ch, category });
										}
									} else {
										actions.push({ kind: 'text', text: run, category });
									}
								} else {
									actions.push({ kind: 'text', text: run, category });
								}
							} else if (/^\d+$/.test(run)) {
								for (const ch of run) actions.push({ kind: 'special', token: ch });
							} else {
								for (const ch of run) {
									if (isEarcon(ch)) actions.push({ kind: 'earcon', token: ch, category });
									else if (isSpecial(ch)) actions.push({ kind: 'special', token: ch });
									else actions.push({ kind: 'text', text: ch, category });
								}
							}
						}
						return;
					}

					// CamelCase splitting
					if (isCamelCase(text)) {
						for (const seg of splitCamel(text)) {
							if (/^[A-Z]/.test(seg)) {
								actions.push({ kind: 'text', text: seg, category });
							} else {
								for (const ch of seg) actions.push({ kind: 'text', text: ch, category });
							}
						}
						return;
					}

					// Pure punctuation/digits/runs
					if (!/^[A-Za-z]+$/.test(text) && [...text].every(ch => isEarcon(ch) || isSpecial(ch))) {
						for (const ch of text) {
							if (isEarcon(ch)) actions.push({ kind: 'earcon', token: ch, category });
							else if (isSpecial(ch)) actions.push({ kind: 'special', token: ch });
							else actions.push({ kind: 'text', text: ch, category });
						}
						return;
					}

					// Fallback: everything else as one text chunk
					actions.push({ kind: 'text', text, category });
				}

				console.log('⏺ raw LSP tokens:', tokens);

				for (const { text, category } of tokens) {
					// 1) Two-letter tokens: split into letters unless whitelisted
					if (/^[A-Za-z]{2}$/.test(text) && !['keyword', 'comment', 'string'].includes(category)) {
						console.log(`↳ two‐letter split for “${text}” at index`);
						flush();
						const twoLenExceptions = new Set(['no', 'is', 'if', 'on', 'in']);
						if (!twoLenExceptions.has(text.toLowerCase())) {
							for (const ch of text) actions.push({ kind: 'text', text: ch, category });
						} else {
							actions.push({ kind: 'text', text, category });
						}
						continue;
					}
					// 2) Three-letter tokens: if in dictionary and not exception, read whole; else split
					if (/^[A-Za-z]{3}$/.test(text) && !['keyword', 'comment', 'string'].includes(category)) {
						flush();
						const threeLenExceptions = new Set(['fmt']);
						const lower = text.toLowerCase();
						if (isDictionaryWord(text) && !threeLenExceptions.has(lower)) {
							actions.push({ kind: 'text', text, category });
						} else {
							for (const ch of text) actions.push({ kind: 'text', text: ch, category });
						}
						continue;
					}
					if (text.includes('_')) {
						flush();
						console.log('▶▶ underscore-split token:', JSON.stringify(text));
						const parts = text.split(/(_)/);
						console.log('   parts:', parts, 'lengths:', parts.map(p => p.length));
						for (const part of parts) {
							if (!part) continue;
							console.log('     ↳ part:', JSON.stringify(part), 'len=', part.length);
							if (part === '_') {
								actions.push({ kind: 'special', token: '_' });
							} else if (part.length <= 2) {
								for (const ch of part) {
									actions.push({ kind: 'text', text: ch, category });
								}
							} else {
								actions.push({ kind: 'text', text: part, category });
							}
						}
						continue;
					}


					// ── A) Comments stay whole ──────────────────────────────────────────────
					if (category === 'comment') {
						if (bufferCat === category) {
							buffer += text;
						} else {
							flush();
							buffer = text;
							bufferCat = category;
						}
						continue;
					}
					// ── B) STRING LITERALS: detect prefixes & delimiters robustly ────────────
					const stringMatch = /^(?:[rbufRBUF]*)(['"])([\s\S]*?)\1$/.exec(text);
					if (stringMatch || category === 'string') {
						// flush any buffered text first
						flush();
						const delim = stringMatch ? stringMatch[1] : text[0];
						const content = stringMatch ? stringMatch[2] : text.slice(1, -1);
						// opening quote earcon
						actions.push({ kind: 'earcon', token: delim, category });
						// split inner content
						if (content) splitToken(content, category);
						// closing quote earcon
						actions.push({ kind: 'earcon', token: delim, category });
						continue;
					}

					// ── 2) Bypass keywords (don’t split “for”, “if”, “in”, etc.) ───────────
					if (category === 'keyword') {
						if (bufferCat === category) {
							buffer += text;
						} else {
							flush();
							buffer = text;
							bufferCat = category;
						}
						continue;
					}



					// ── C) Dictionary words: read whole if in our word list ───────
					if (/^[A-Za-z]+$/.test(text) && isDictionaryWord(text)) {
						flush();
						actions.push({ kind: 'text', text, category });
						continue;
					}
					// ── C) UNDERSCORE SPLITTING (now first!) ────────────────────────────────
					if (text.includes('_')) {
						flush();
						console.log('▶▶ underscore‐split token:', JSON.stringify(text));
						for (const part of text.split(/(_)/)) {
							if (!part) continue;
							if (part === '_') {
								actions.push({ kind: 'special', token: '_' });
							} else {
								if (part.length <= 2) {
									// -- log each letter as we push it --
									for (const ch of part) {
										console.log('    ↳ splitting letter:', ch);
										actions.push({ kind: 'text', text: ch, category });
									}
								} else {
									actions.push({ kind: 'text', text: part, category });
								}
							}
						}
						continue;
					}

					// ── D) ACRONYM / DIGIT SPLITTING ─────────────────────────────────────────
					if (category === 'variable' && /[A-Za-z]/.test(text) && /\d|[^A-Za-z0-9]/.test(text)) {
						flush();
						const runs = text.match(/[A-Za-z]+|\d+|[^A-Za-z0-9]+/g)!;
						for (const run of runs) {
							if (/^[A-Za-z]+$/.test(run)) {
								// only split short runs ≤2; longer stay chunk
								if (run.length <= 2) {
									for (const ch of run) actions.push({ kind: 'text', text: ch, category });
								} else {
									actions.push({ kind: 'text', text: run, category });
								}
							} else if (/^\d+$/.test(run)) {
								for (const ch of run) actions.push({ kind: 'special', token: ch });
							} else {
								for (const ch of run) {
									if (isEarcon(ch)) actions.push({ kind: 'earcon', token: ch, category });
									else if (isSpecial(ch)) actions.push({ kind: 'special', token: ch });
									else actions.push({ kind: 'text', text: ch, category });
								}
							}
						}
						continue;
					}

					// ── D) CamelCase splitting ──────────────────────────────────────
					if (isCamelCase(text)) {
						flush();
						for (const segment of splitCamel(text)) {
							if (/^[A-Z]/.test(segment)) {
								actions.push({ kind: 'text', text: segment, category });
							} else {
								for (const ch of segment) {
									actions.push({ kind: 'text', text: ch, category });
								}
							}
						}
						continue;
					}

					// ── E) Punctuation/special splitting ───────────────────────────
					if (text.length > 1 && [...text].every(ch => isEarcon(ch) || isSpecial(ch))) {
						flush();
						for (const ch of text) {
							if (isEarcon(ch)) {
								actions.push({ kind: 'earcon', token: ch, category });
							} else if (isSpecial(ch)) {
								actions.push({ kind: 'special', token: ch });
							} else {
								actions.push({ kind: 'text', text: ch, category });
							}
						}
						continue;
					}

					// ── F) Single-char earcon? ──────────────────────────────────────────────────
					if (isEarcon(text)) {
						flush();
						actions.push({ kind: 'earcon', token: text, category });

						// ── G) Single char Special? ───────────────────────────────────────────
					} else if (isSpecial(text)) {
						flush();
						actions.push({ kind: 'special', token: text });

						// ── H) Otherwise, accumulate same category text ────────────────────
					} else {
						if (bufferCat === category) {
							buffer += text;
						} else {
							flush();
							buffer = text;
							bufferCat = category;
						}
					}
				}
				flush();  // push any trailing text

				// 1. Merge adjacent text actions to reduce speakToken calls
				const mergedActions: Action[] = [];
				let accText = '';
				let accCat: string | null = null;

				for (const act of actions) {
					if (act.kind === 'text') {
						// detect a single‐letter split chunk:
						const isSplitLetter = act.text.length === 1 && act.category === 'variable';
						// only merge if same category AND NOT two split‐letters in a row
						if (
							accCat === act.category
							&& !(isSplitLetter && accText.length === 1)
						) {
							accText += act.text;
						} else {
							if (accText) mergedActions.push({ kind: 'text', text: accText, category: accCat! });
							accText = act.text;
							accCat = act.category;
						}
					} else {
						// flush any pending text
						if (accText) {
							mergedActions.push({ kind: 'text', text: accText, category: accCat! });
							accText = '';
							accCat = null;
						}
						// push the non-text action
						mergedActions.push(act);
					}
				}
				// final flush
				if (accText) mergedActions.push({ kind: 'text', text: accText, category: accCat! });

				// Strip any leading characters in a text chunk that were just played as an earcon
				for (let i = 1; i < mergedActions.length; i++) {
					const prev = mergedActions[i - 1];
					const curr = mergedActions[i];
					if (prev.kind === 'earcon' && curr.kind === 'text') {
						let txt = curr.text;
						// Remove all repeating leading tokens
						while (txt.startsWith(prev.token)) {
							txt = txt.slice(prev.token.length);
						}
						curr.text = txt;
					}
				}

				// Remove consecutive duplicate special tokens (e.g., repeated digits)
				let deduped: Action[] = [];
				for (const act of mergedActions) {
					const prev = deduped[deduped.length - 1];
					if (
						prev
						&& act.kind === 'special'
						&& prev.kind === 'special'
						&& act.token === prev.token
					) {
						continue; // skip duplicate
					}
					deduped.push(act);
				}
				mergedActions.splice(0, mergedActions.length, ...deduped);
				console.log('🔍 mergedActions:', mergedActions);

				// 3) Pipeline TTS: kick off all generation immediately
				const audioFiles = mergedActions.map(act => {
					if (act.kind === 'earcon') {
						return Promise.resolve(audioMap[act.token]);
					} else if (act.kind === 'special') {
						const word = specialCharMap[act.token];
						return genTokenAudio(word, 'text');
					} else if (act.kind === 'text' && act.text.length === 1 && audioMap[act.text]) {
						// direct letter audio
						return Promise.resolve(audioMap[act.text]);
					} else {
						const ttsCat = act.category === 'string' ? 'text' : act.category;
						return genTokenAudio(act.text, ttsCat);
					}
				});

				// 4) Play in order, after ensuring all audio is generated
				const files = await Promise.all(audioFiles);
				// Instrument playback loop with timing logs
				lipcoderLog.appendLine('[diagnostic] Starting playback of tokens');
				for (let idx = 0; idx < mergedActions.length; idx++) {
					const act = mergedActions[idx];
					const file = files[idx];
					const start = process.hrtime.bigint();
					lipcoderLog.appendLine(`[diagnostic] About to play token ${idx} kind=${act.kind}`);
					if (act.kind === 'text') {
						// Regular text chunks via PCM streamer
						await playSequence([file], { rate: playSpeed });
					} else if (act.kind === 'earcon') {
						// Punctuation/symbol earcons with a brief pause
						await playWave(file, { isEarcon: true });
						const pauseMs = 200 / playSpeed;
						await delay(pauseMs);
					} else if (act.kind === 'special') {
						// Spoken words for symbols/digits
						await playSequence([file], { rate: playSpeed });
					}
					const end = process.hrtime.bigint();
					const ms = Number(end - start) / 1e6;
					lipcoderLog.appendLine(`[diagnostic] Played token ${idx} in ${ms.toFixed(2)}ms`);
				}
				lipcoderLog.appendLine('[diagnostic] Completed playback of all tokens');

			} catch (err: any) {
				// persist into the LipCoder Output channel:
				lipcoderLog.appendLine(`⏺ readLineTokens error: ${err.stack || err}`);
				lipcoderLog.show(/* preserveFocus */ false);

				// still let the user know:
				vscode.window.showErrorMessage(`readLineTokens failed: ${err.message}`);
			}
		})
	);

	// ── 3.4 stopReadLineTokens: Abort any in-flight speech ──────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.stopReadLineTokens', () => {
			if (currentAbortController) {
				currentAbortController.abort();
				currentAbortController = null;
				vscode.window.showInformationMessage('LipCoder speech stopped');
			}
		})
	);

	// ── 4. Speak tokens as the user types ─────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.toggleTypingSpeech', () => {
			typingSpeechEnabled = !typingSpeechEnabled;
			const status = typingSpeechEnabled ? 'enabled' : 'disabled';
			vscode.window.showInformationMessage(`Typing speech is now ${status}`);
		})
	);

	interface LineSeverityMap { [line: number]: vscode.DiagnosticSeverity }
	const diagCache: Map<string /* uri */, LineSeverityMap> = new Map();

	vscode.languages.onDidChangeDiagnostics(e => {
		for (const uri of e.uris) {
			const all = vscode.languages.getDiagnostics(uri)
				.filter(d => d.source === 'Pylance');
			const lineMap: LineSeverityMap = {};
			for (const d of all) {
				const ln = d.range.start.line;
				// pick highest‐priority (Error < Warning < Info < Hint)
				lineMap[ln] = Math.min(
					lineMap[ln] ?? vscode.DiagnosticSeverity.Hint,
					d.severity
				);
			}
			diagCache.set(uri.toString(), lineMap);
		}
	});

	vscode.window.onDidChangeTextEditorSelection(e => {
		const uri = e.textEditor.document.uri.toString();
		// just look at the primary cursor position:
		const lineNum = e.selections[0].start.line;
		const lineText = e.textEditor.document.lineAt(lineNum).text;
		// count spaces or tabs:
		const leading = (lineText.match(/^\s*/)?.[0] || '');
		// convert to indent units (floor of spaces/tabSize or 1 char per \t):
		const units = leading[0] === '\t'
			? Math.min(leading.length, MAX_INDENT_UNITS)
			: Math.min(Math.floor(leading.length / tabSize), MAX_INDENT_UNITS);

		indentLevels.set(uri, units);
	});

	// keep a simple per‐document indent counter
	const indentLevels: Map<string, number> = new Map();
	const MAX_INDENT_UNITS = 5; // maximum nesting
	const MIN_INDENT_UNITS = 0;

	const editor = vscode.window.activeTextEditor!;
	const tabSize = typeof editor.options.tabSize === 'number'
		? editor.options.tabSize
		: 4;  // fallback if somehow not a number

	// Flag to skip indent sound once after Enter
	let skipNextIndent = false;

	vscode.workspace.onDidChangeTextDocument(async (event) => {
		if (!typingSpeechEnabled) return;
		const editor = vscode.window.activeTextEditor;
		if (!editor || event.document !== editor.document) return;

		const changes = event.contentChanges;
		if (changes.length === 0) return;

		const MAX_UNITS = 5;
		const MIN_UNITS = 0;


		for (const change of changes) {
			console.log('⟶ change.text:', JSON.stringify(change.text),
				'rangeLength:', change.rangeLength,
				'startChar:', change.range.start.character);

			const uri = event.document.uri.toString();

			// ── 1) ENTER FIRST: if *any* change is a newline, play it and bail ─────────
			// Detect Enter even when auto-indent is inserted (e.g., '\n    ')
			if (changes.some(c => c.text.startsWith('\n'))) {
				stopPlayback();

				// pick the right enter sound
				const newlineChange = changes.find(c => c.text.startsWith('\n'))!;
				const enterLine = newlineChange.range.start.line;
				const sevMap = diagCache.get(uri) || {};
				const sev = sevMap[enterLine] ?? vscode.DiagnosticSeverity.Hint;
				const fileMap = {
					[vscode.DiagnosticSeverity.Error]: 'enter2.wav',
					[vscode.DiagnosticSeverity.Warning]: 'enter2.wav',
					[vscode.DiagnosticSeverity.Information]: 'enter2.wav',
					[vscode.DiagnosticSeverity.Hint]: 'enter.wav',
				} as const;
				const enterFile = path.join(audioDir, 'earcon', fileMap[sev]);
				await playWave(enterFile, { isEarcon: true });

				// reset indent state so the following auto-indent spaces look fresh
				indentLevels.set(uri, 0);
				skipNextIndent = true;
				return;   // <<< bail out before indent logic
			}

			// ── 2) Handle indent for Tab, Backspace, and auto-indents ─────────────────
			const oldRaw = indentLevels.get(uri) ?? 0;
			const lineNum = changes[0].range.start.line;
			const lineText = event.document.lineAt(lineNum).text;
			const leading = (lineText.match(/^\s*/)?.[0] || '');
			const rawUnits = Math.floor(leading.length / tabSize);

			if (skipNextIndent) {
				skipNextIndent = false;
				indentLevels.set(uri, rawUnits);
			} else {
				const isBackspace = changes.some(c => c.text === '' && c.rangeLength === 1);
				// detect Tab key when VSCode inserts literal '\t' or spaces equal to tabSize
				const isTab = changes.some(c =>
					c.text === '\t'
					|| (tabSize > 0 && c.text === ' '.repeat(tabSize))
				);

				if (isTab) {
					// Manual Tab: indent_0 → indent_4
					const idx = rawUnits > 4 ? 4 : rawUnits;
					await playWave(path.join(audioDir, 'earcon', `indent_${idx}.wav`), { isEarcon: true });
					indentLevels.set(uri, rawUnits);

				} else if (isBackspace) {
					// Manual Backspace: indent_5 → indent_9
					const idx = rawUnits + 5 > 9 ? 9 : rawUnits + 5;
					await playWave(path.join(audioDir, 'earcon', `indent_${idx}.wav`), { isEarcon: true });
					indentLevels.set(uri, rawUnits);

				} else {
					// Auto-indent: same as before
					if (rawUnits > oldRaw) {
						const idx = rawUnits > MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : rawUnits - 1;
						await playWave(path.join(audioDir, 'earcon', `indent_${idx}.wav`), { isEarcon: true });
					} else if (rawUnits < oldRaw) {
						const idx = rawUnits > MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : rawUnits;
						await playWave(path.join(audioDir, 'earcon', `indent_${idx}.wav`), { isEarcon: true });
					}
					indentLevels.set(uri, rawUnits);
				}
			}


			// ── 3) Finally, handle plain backspace (single-char delete) ───────────────
			//    change.text==='' and exactly one character removed
			for (const change of changes) {
				if (change.text === '' && change.rangeLength === 1) {
					stopPlayback();
					await playWave(path.join(audioDir, 'earcon', 'backspace.wav'), { isEarcon: true });
					break;
				}
			}

			// 4) Otherwise, single‐char logic:
			const char = change.text;
			if (char.length !== 1) continue;

			stopPlayback();

			try {
				if (audioMap[char]) {
					await playWave(audioMap[char], { isEarcon: true }); // ✅ mark as earcon to apply rate
				} else if (specialCharMap[char]) {
					stopPlayback();
					const word = specialCharMap[char];
					await playSpecial(word);
				} else if (/^[a-zA-Z]$/.test(char)) {
					const path = audioMap[char.toLowerCase()];
					if (path) await playWave(path);
				} else {
					console.log('🚫 No audio found for:', char);
				}
			} catch (err) {
				console.error('Typing audio error:', err);
			}
		}
	});
}

export function deactivate() {
	// LanguageClient disposal is handled automatically via context.subscriptions
	console.log('[extension] activate() completed');
	lipcoderLog.appendLine('[extension] activate() completed');
}