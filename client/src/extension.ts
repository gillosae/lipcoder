// client/src/extension.ts

import * as vscode from 'vscode';
import {
	LanguageClient,
	ServerOptions,
	TransportKind,
	LanguageClientOptions
} from 'vscode-languageclient/node';
import * as path from 'path';
import { SymbolInformation } from 'vscode-languageserver-types';
import {
	setBackend,
	TTSBackend,
	speakToken,
	setAudioDirectory
} from './audio';

export function activate(context: vscode.ExtensionContext) {
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
		',': path.join(extRoot, 'client', 'src', 'audio', 'comma.wav'),
		'.': path.join(extRoot, 'client', 'src', 'audio', 'dot.wav'),
		';': path.join(extRoot, 'client', 'src', 'audio', 'semicolon.wav'),
		'/': path.join(extRoot, 'client', 'src', 'audio', 'slash.wav'),
		'_': path.join(extRoot, 'client', 'src', 'audio', 'underbar.wav'),
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

	// ── 3.3 readLineTokens (with underscore & CamelCase splitting) ────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.readLineTokens', async () => {
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
					// e.g. "extRootValue" → ["ext","Root","Value"]
					return id.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || [id];
				}

				for (const { text, category } of tokens) {
					// ── 2.a Underscore splitting ──────────────────────────────────────
					if (text.includes('_')) {
						flush();
						// keep underscores in the array
						for (const part of text.split(/(_)/)) {
							if (part === '') continue;
							if (part === '_') {
								actions.push({ kind: 'earcon', token: '_', category });
							} else if (part.length <= 2) {
								// letter-by-letter for short segments
								for (const ch of part) {
									actions.push({ kind: 'text', text: ch, category });
								}
							} else {
								// read as chunk
								actions.push({ kind: 'text', text: part, category });
							}
						}
						continue;
					}

					// ── 2.b CamelCase splitting ──────────────────────────────────────
					if (isCamelCase(text)) {
						flush();
						for (const segment of splitCamel(text)) {
							if (/^[A-Z]/.test(segment)) {
								// chunk that starts uppercase (e.g. "Root")
								actions.push({ kind: 'text', text: segment, category });
							} else {
								// lowercase segment, letter-by-letter (e.g. "ext")
								for (const ch of segment) {
									actions.push({ kind: 'text', text: ch, category });
								}
							}
						}
						continue;
					}

					// ── 2.c Punctuation/special splitting ───────────────────────────
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

					// ── 2.d Earcon? ──────────────────────────────────────────────────
					if (isEarcon(text)) {
						flush();
						actions.push({ kind: 'earcon', token: text, category });

						// ── 2.e Special char? ───────────────────────────────────────────
					} else if (isSpecialChar(text)) {
						flush();
						actions.push({ kind: 'special', token: text });

						// ── 2.f Otherwise, accumulate for coalescing ────────────────────
					} else {
						if (!buffer) {
							buffer = text;
							bufferCat = category;
						}
						else if (category === bufferCat) {
							buffer += text;
						}
						else {
							flush();
							buffer = text;
							bufferCat = category;
						}
					}
				}
				flush();  // push any trailing text

				// 3) Playback
				for (const act of actions) {
					if (act.kind === 'text') {
						await speakToken(act.text, act.category);
					} else if (act.kind === 'earcon') {
						await speakToken(act.token, act.category);
					} else {
						const word = specialCharMap[act.token];
						await speakToken(word, 'text', { speaker: 'en_6' });
					}
				}

			} catch (err: any) {
				vscode.window.showErrorMessage(`readLineTokens failed: ${err.message}`);
			}
		})
	);
}

export function deactivate() {
	// LanguageClient disposal is handled automatically via context.subscriptions
}