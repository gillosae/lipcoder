// client/src/extension.ts

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
	playWave
} from './audio';
import { lipcoderLog } from './logger';
import { createAudioMap, specialCharMap } from './mapping';

let typingSpeechEnabled = true; // global flag to control typing speech

export async function activate(context: vscode.ExtensionContext) {
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

	// ── 1) Build the unified audioMap ─────────────────────────────────────────────
	const audioMap = createAudioMap(context);

	function isEarcon(ch: string): boolean {
		// any single-character token that you want as an earcon
		return ch.length === 1 && audioMap[ch] !== undefined;
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
				const res = await client.sendRequest<{ text: string }>(
					'lipcoder/echo',
					{ text: 'hello' }
				);
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
					// if ([...text].every(ch => isEarcon(ch) || isSpecial(ch))) {
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


					// ── A) Comments stay whole, but STRING LITERALS get quote-earcons ────
					if (category === 'comment') {
						// comments: accumulate as before
						if (bufferCat === category) {
							buffer += text;
						} else {
							flush();
							buffer = text;
							bufferCat = category;
						}
						continue;
					}
					if (
						category === 'string'
						|| (
							(text.startsWith('"') && text.endsWith('"'))
							|| (text.startsWith("'") && text.endsWith("'"))
						)
					) {
						// make sure any buffered text is flushed first
						flush();
						// assume text starts+ends with same quote char
						const delim = text[0];
						const content = text.slice(1, -1);

						// 1) opening quote earcon
						actions.push({ kind: 'earcon', token: delim, category });

						// 2) split the inner content exactly like any other token
						if (content) {
							splitToken(content, category);
						}

						// 3) closing quote earcon
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

				// 3) Pipeline TTS: kick off all generation immediately
				const audioFiles = mergedActions.map(act => {
					if (act.kind === 'earcon') {
						// earcon WAV is already on disk
						return Promise.resolve(audioMap[act.token]);
					} else if (act.kind === 'special') {
						// map symbol → word, then generate
						const word = specialCharMap[act.token];
						return genTokenAudio(word, 'text');
					} else {
						// generate TTS for text chunk
						const ttsCat = act.category === 'string' ? 'text' : act.category;
						return genTokenAudio(act.text, ttsCat);
					}
				});

				// 4) Play in order, overlapping gen of [i+1] with play of [i], abortable
				if (audioFiles.length > 0) {
					let prevGen = audioFiles[0];
					for (let i = 0; i < audioFiles.length - 1; i++) {
						if (signal.aborted) break;
						const file = await prevGen;

						if (signal.aborted) break;
						prevGen = audioFiles[i + 1];
						await playWave(file);
					}
					if (!signal.aborted) {
						await playWave(await prevGen);
					}
				}

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

	vscode.workspace.onDidChangeTextDocument(async (event) => {
		if (!typingSpeechEnabled) return;

		const editor = vscode.window.activeTextEditor;
		if (!editor || event.document !== editor.document) return;

		const changes = event.contentChanges;
		if (changes.length === 0) return;

		for (const change of changes) {
			const text = change.text;
			if (text.length !== 1) continue;

			const char = text;

			try {
				if (audioMap[char]) {
					await playWave(audioMap[char], { isEarcon: true }); // ✅ mark as earcon to apply rate
				} else if (specialCharMap[char]) {
					const word = specialCharMap[char];
					const path = await genTokenAudio(word, 'text');
					await playWave(path);
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
}