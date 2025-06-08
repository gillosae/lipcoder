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


export async function activate(context: vscode.ExtensionContext) {
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

	// ── Module-scope controller for cancellation ─────────────────────────────────
	let currentAbortController: AbortController | null = null;

	// ── 1. Configure Silero TTS & locate earcons ────────────────────────────────────
	const extRoot = context.extensionPath;
	const pythonExe = path.join(extRoot, 'client', 'src', 'python', 'bin', 'python');
	const scriptPath = path.join(extRoot, 'client', 'src', 'python', 'silero_tts_infer.py');

	// Tell audio.ts exactly where your WAVs live on disk:
	setAudioDirectory(path.join(extRoot, 'client', 'src', 'audio'));

	setBackend(TTSBackend.Silero, {
		pythonExe,
		scriptPath,
		language: 'en',
		modelId: 'v3_en',
		defaultSpeaker: 'en_2',
		sampleRate: 24000,
		// gap: 0,
		// speed: 400
	});

	// Paths for common sounds
	const earconPath = path.join(extRoot, 'client', 'src', 'audio', 'earcon.wav');
	const spacePath = path.join(extRoot, 'client', 'src', 'audio', 'space.wav');
	const quotePath = path.join(extRoot, 'client', 'src', 'audio', 'quote.wav');
	const quote2Path = path.join(extRoot, 'client', 'src', 'audio', 'quote2.wav');
	const bigquotePath = path.join(extRoot, 'client', 'src', 'audio', 'bigquote.wav');
	const bigquote2Path = path.join(extRoot, 'client', 'src', 'audio', 'bigquote2.wav');

	// Map for single-character punctuation -> earcon file
	const audioMap: Record<string, string> = {
		'{': path.join(extRoot, 'client', 'src', 'audio', 'brace.wav'),
		'}': path.join(extRoot, 'client', 'src', 'audio', 'brace2.wav'),
		'<': path.join(extRoot, 'client', 'src', 'audio', 'anglebracket.wav'),
		'>': path.join(extRoot, 'client', 'src', 'audio', 'anglebracket2.wav'),
		'[': path.join(extRoot, 'client', 'src', 'audio', 'squarebracket.wav'),
		']': path.join(extRoot, 'client', 'src', 'audio', 'squarebracket2.wav'),
		'(': path.join(extRoot, 'client', 'src', 'audio', 'parenthesis.wav'),
		')': path.join(extRoot, 'client', 'src', 'audio', 'parenthesis2.wav'),
		// ',': path.join(extRoot, 'client', 'src', 'audio', 'comma.wav'),
		// '.': path.join(extRoot, 'client', 'src', 'audio', 'dot.wav'),
		';': path.join(extRoot, 'client', 'src', 'audio', 'semicolon.wav'),
		'/': path.join(extRoot, 'client', 'src', 'audio', 'slash.wav'),
		// '_': path.join(extRoot, 'client', 'src', 'audio', 'underbar.wav'),
		'-': path.join(extRoot, 'client', 'src', 'audio', 'bar.wav'),
		':': path.join(extRoot, 'client', 'src', 'audio', 'column.wav'),
	};

	function isEarcon(text: string): boolean {
		// any single-character token that you want as an earcon
		return text.length === 1 && audioMap[text] !== undefined;
	}

	// Map punctuation *and* digits to spoken words
	const specialCharMap: Record<string, string> = {
		'!': 'excitation',
		'@': 'at',
		'#': 'sharp',
		'$': 'dollar',
		'%': 'percent',
		'^': 'caret',
		'&': 'ampersand',
		'*': 'asterisk',
		'+': 'plus',
		'~': 'tilde',
		'|': 'bar',
		'?': 'question',
		'₩': 'won',
		'=': 'equals',
		'`': 'backtick',
		'\\': 'backslash',
		'.': 'dot',
		',': 'comma',
		'_': 'underbar',
		// ─── new digit mappings ──────────────────────────────────────────
		'0': 'zero',
		'1': 'one',
		'2': 'two',
		'3': 'three',
		'4': 'four',
		'5': 'five',
		'6': 'six',
		'7': 'seven',
		'8': 'eight',
		'9': 'nine',
		// ─── Letters ──────────────────────────────────────────
		'a': 'ay',
		'b': 'bee',
		'c': 'see',
		'd': 'dee',
		'e': 'ee',
		'f': 'eff',
		'g': 'gee',
		'h': 'aitch',
		'i': 'eye',
		'j': 'jay',
		'k': 'kay',
		'l': 'el',
		'm': 'em',
		'n': 'en',
		'o': 'oh',
		'p': 'pee',
		'q': 'cue',
		'r': 'ar',
		's': 'ess',
		't': 'tee',
		'u': 'you',
		'v': 'vee',
		'w': 'double you',
		'x': 'ex',
		'y': 'why',
		'z': 'zee',
	};

	function isSpecialChar(text: string): boolean {
		return text.length === 1 && specialCharMap[text] !== undefined;
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
		documentSelector: [{ scheme: 'file', language: '*' }],
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
				const tokens = await client.sendRequest<
					{ text: string; category: string }[]
				>('lipcoder/readLineTokens', { uri, line });

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

				for (const { text, category } of tokens) {
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
					if (category === 'string') {
						flush();
						// assume text starts+ends with same quote char
						const delim = text[0];
						const content = text.slice(1, -1);

						// 1) opening quote earcon
						actions.push({ kind: 'earcon', token: delim, category });
						// 2) inner content (may be empty)
						if (content) {
							actions.push({ kind: 'text', text: content, category });
						}
						// 3) closing quote earcon (toggle sound on second call via audio.ts)
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
						for (const part of text.split(/(_)/)) {
							if (!part) continue;
							if (part === '_') {
								// actions.push({ kind: 'earcon', token: '_', category });
								actions.push({ kind: 'special', token: '_' });
							} else {
								// chunk words longer than 2, letter-by-letter else
								if (part.length <= 2) {
									for (const ch of part) {
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
									else if (isSpecialChar(ch)) actions.push({ kind: 'special', token: ch });
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
					if (text.length > 1 && [...text].every(ch => isEarcon(ch) || isSpecialChar(ch))) {
						flush();
						for (const ch of text) {
							if (isEarcon(ch)) {
								actions.push({ kind: 'earcon', token: ch, category });
							} else if (isSpecialChar(ch)) {
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
					} else if (isSpecialChar(text)) {
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
				const merged: Action[] = [];
				let accText = '';
				let accCat: string | null = null;

				for (const act of actions) {
					if (act.kind === 'text') {
						if (accCat === act.category) {
							// same category: append
							accText += act.text;
						} else {
							// push previous
							if (accText) merged.push({ kind: 'text', text: accText, category: accCat! });
							accText = act.text;
							accCat = act.category;
						}
					} else {
						// flush any pending text
						if (accText) {
							merged.push({ kind: 'text', text: accText, category: accCat! });
							accText = '';
							accCat = null;
						}
						// push the non-text action
						merged.push(act);
					}
				}
				// final flush
				if (accText) merged.push({ kind: 'text', text: accText, category: accCat! });

				// 3) Pipeline TTS: kick off all generation immediately
				const audioFiles = merged.map(act => {
					if (act.kind === 'earcon') {
						// earcon WAV is already on disk
						return Promise.resolve(audioMap[act.token]);
					} else if (act.kind === 'special') {
						// map symbol → word, then generate
						const word = specialCharMap[act.token];
						return genTokenAudio(word, 'text');
					} else {
						// generate TTS for text chunk
						return genTokenAudio(act.text, act.category);
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
}

export function deactivate() {
	// LanguageClient disposal is handled automatically via context.subscriptions
}