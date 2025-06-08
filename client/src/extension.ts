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
	stopPlayback
} from './audio';
import { lipcoderLog } from './logger';
import { createAudioMap, specialCharMap } from './mapping';

let typingSpeechEnabled = true; // global flag to control typing speech

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

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
			// { scheme: 'file', language: 'python' },
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
			// const enterChange = changes.find(c => c.text === '\n');
			if (changes.some(c => c.text === '\n')) {
				stopPlayback();

				// pick the right enter sound
				const enterLine = changes.find(c => c.text === '\n')!.range.start.line;
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

				return;   // <<< bail out before indent logic
			}

			// ── 2) Now handle indent / de-indent in one pass ─────────────────────────────
			// Get the *raw* old indent (could be > MAX_UNITS)
			const oldRaw = indentLevels.get(uri) ?? 0;
			const lineNum = event.contentChanges[0].range.start.line;
			const lineText = event.document.lineAt(lineNum).text;
			const leading = (lineText.match(/^\s*/)?.[0] || '');
			const rawUnits = Math.floor(leading.length / tabSize);

			if (rawUnits > oldRaw) {
				// indent
				if (rawUnits > MAX_UNITS) {
					await playWave(path.join(audioDir, 'earcon', `indent_${MAX_UNITS - 1}.wav`), { isEarcon: true });
				} else {
					await playWave(path.join(audioDir, 'earcon', `indent_${rawUnits - 1}.wav`), { isEarcon: true });
				}
			}
			else if (rawUnits < oldRaw) {
				// de-indent
				if (rawUnits >= MAX_UNITS) {
					await playWave(path.join(audioDir, 'earcon', `indent_${MAX_UNITS}.wav`), { isEarcon: true });
				} else {
					const idx = rawUnits === 0 ? 9 : 9 - rawUnits;
					await playWave(path.join(audioDir, 'earcon', `indent_${idx}.wav`), { isEarcon: true });
				}
			}


			// // indent
			// if (rawUnits > oldRaw) {
			// 	if (rawUnits > MAX_UNITS) {
			// 		// you’ve just gone past max → play indent_4.wav
			// 		await playWave(path.join(audioDir, 'earcon', `indent_${MAX_UNITS - 1}.wav`), { isEarcon: true });
			// 		indentLevels.set(uri, rawUnits);
			// 	} else {
			// 		// normal indent: 1→indent_0.wav, 2→indent_1.wav, …, 5→indent_4.wav
			// 		const idx = rawUnits - 1;
			// 		await playWave(path.join(audioDir, 'earcon', `indent_${idx}.wav`), { isEarcon: true });
			// 		indentLevels.set(uri, rawUnits);
			// 	}
			// }
			// // de-indent
			// else if (rawUnits < oldRaw) {
			// 	if (rawUnits >= MAX_UNITS) {
			// 		// you deleted but you’re still ≥ max → play indent_5.wav
			// 		await playWave(path.join(audioDir, 'earcon', `indent_${MAX_UNITS}.wav`), { isEarcon: true });
			// 		indentLevels.set(uri, rawUnits);
			// 	} else {
			// 		// normal de-indent below max: mirror 0→9, 1→8, …, 4→5
			// 		const idx = rawUnits === 0 ? 9 : 9 - rawUnits;
			// 		await playWave(path.join(audioDir, 'earcon', `indent_${idx}.wav`), { isEarcon: true });
			// 		indentLevels.set(uri, rawUnits);
			// 	}
			// }
			// // else rawUnits == oldRaw → no change

			// Finally, store the *raw* units for next time
			indentLevels.set(uri, rawUnits);


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