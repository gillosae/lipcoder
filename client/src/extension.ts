import * as vscode from 'vscode';
import { setBackend, TTSBackend } from './audio';
import { createAudioMap } from './mapping';
import { preloadEverything } from './preload';
import { config, initConfig } from './config';
import { log } from './utils';

import { registerEchoTest } from './features/echo_test';
import { registerWhereAmI } from './features/where_am_i';
import { loadDictionaryWord, registerReadLineTokens } from './features/read_line_tokens';
import { registerStopReadLineTokens } from './features/stop_read_line_tokens';
import { registerToggleTypingSpeech } from './features/toggle_typing_speech';
import { startLanguageClient } from './language_client';
import { updateLineSeverity } from './features/line_severity';
import { readTextTokens } from './features/read_text_tokens';


export async function activate(context: vscode.ExtensionContext) {
	// Provide the extension root to our config
	initConfig(context);
	log('[extension] activate() called');
	vscode.window.showInformationMessage('LipCoder: activate() called');

	// 0) TTS setup ───────────────────────────────────────────────────────────────
	loadDictionaryWord();

	setBackend(TTSBackend.Silero, {
		pythonPath: config.pythonPath(),
		scriptPath: config.scriptPath(),
		language: 'en',
		modelId: 'v3_en',
		defaultSpeaker: 'en_3',
		sampleRate: 24000,
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.setPlaySpeed', async () => {
			const input = await vscode.window.showInputBox({
				prompt: 'Set LipCoder playback speed multiplier (e.g., 1.0 = normal, 1.5 = 50% faster)',
				value: config.playSpeed.toString()
			});
			if (input !== undefined) {
				const val = parseFloat(input);
				if (!isNaN(val) && val > 0) {
					config.playSpeed = val;
					vscode.window.showInformationMessage(`LipCoder playback speed set to ${val}×`);
				} else {
					vscode.window.showErrorMessage('Invalid playback speed. Enter a positive number.');
				}
			}
		})
	);

	// Module-scope controller for cancellation
	let currentAbortController: AbortController | null = null;

	// 1) Pre-generate earcons into cache ────────────────────────────
	preloadEverything(context);

	// 2) Build the unified audioMap ─────────────────────────────────────────────
	const audioMap = createAudioMap(context);

	// 3) Start LanguageClient ──────────────────────────────────────────────────
	const client = startLanguageClient(context);

	// 4) Register commands ───────────────────────────────────────────────────────
	registerEchoTest(context, client);
	registerWhereAmI(context, client);
	registerReadLineTokens(context, client, currentAbortController, audioMap);
	registerStopReadLineTokens(context, client, currentAbortController);
	registerToggleTypingSpeech(context, client);

	const diagCache = updateLineSeverity();


	// 5) Track Cursor Movement ────────────────────────────────────────────────────
	const indentLevels: Map<string, number> = new Map();
	const MAX_INDENT_UNITS = 5; // maximum nesting
	const MIN_INDENT_UNITS = 0;
	const editor = vscode.window.activeTextEditor!;
	const tabSize = typeof editor.options.tabSize === 'number'
		? editor.options.tabSize
		: 4;  // fallback if somehow not a number

	vscode.window.onDidChangeTextEditorSelection(e => {
		const uri = e.textEditor.document.uri.toString();
		const lineNum = e.selections[0].start.line;
		const lineText = e.textEditor.document.lineAt(lineNum).text;
		const leading = (lineText.match(/^\s*/)?.[0] || '');
		const units = leading[0] === '\t'
			? Math.min(leading.length, MAX_INDENT_UNITS)
			: Math.min(Math.floor(leading.length / tabSize), MAX_INDENT_UNITS);

		indentLevels.set(uri, units);
	});



	// 6) Track Text Change ───────────────────────────────────────────────────────
	let skipNextIndent = false; // Flag to skip indent sound once after Enter

	vscode.workspace.onDidChangeTextDocument(async (event) => {
		if (!config.typingSpeechEnabled) return;

		const editor = vscode.window.activeTextEditor;
		if (!editor || event.document !== editor.document) return;

		const changes = event.contentChanges;
		if (changes.length === 0) return;

		readTextTokens(event, diagCache, changes, indentLevels, tabSize, skipNextIndent, MAX_INDENT_UNITS, audioMap);

	});
}

export function deactivate() {
	log('[extension] activate() completed');
}