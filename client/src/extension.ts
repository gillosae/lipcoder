import * as fs from 'fs';
import * as path from 'path';
import { readWordTokens } from './features/read_word_tokens';
import * as vscode from 'vscode';
import { setBackend, TTSBackend, stopPlayback, speakToken } from './audio';
import { createAudioMap } from './mapping';
import { preloadEverything } from './preload';
import { config, initConfig } from './config';
import { log } from './utils';

import { registerEchoTest } from './features/echo_test';
import { registerWhereAmI } from './features/where_am_i';
import { registerReadLineTokens } from './features/read_line_tokens';
import { loadDictionaryWord } from './features/word_logic';
import { registerStopReadLineTokens } from './features/stop_read_line_tokens';
import { stopReadLineTokens } from './features/stop_read_line_tokens';
import { registerToggleTypingSpeech } from './features/toggle_typing_speech';
import { startLanguageClient } from './language_client';
import { updateLineSeverity } from './features/line_severity';
import { readTextTokens } from './features/read_text_tokens';
import { registerReadCurrentLine } from './features/current_line';
import { registerReadFunctionTokens } from './features/read_function_tokens';
import { registerBreadcrumb } from './features/breadcrumb';
import { registerSymbolTree } from './features/symbol_tree';
import { registerSwitchPanel } from './features/switch_panel';
import { registerFunctionList } from './features/function_list';
import { registerFileTree } from './features/file_tree';
// import { registerTerminalReader } from './features/terminal';
import { isFileTreeReading, stopFileTreeReading } from './features/file_tree';

let currentLineNum = -1;

export async function activate(context: vscode.ExtensionContext) {

	console.log('🔍 Extension Host running on Electron v' + process.versions.electron);


	// Provide the extension root to our config
	initConfig(context);
	log('[extension] activate() called');
	vscode.window.showInformationMessage('LipCoder: activate() called');

	// 0) TTS setup ───────────────────────────────────────────────────────────────
	await loadDictionaryWord();

	// Use Silero for TTS
	setBackend(TTSBackend.Silero);

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

	// Track last cursor line to detect line changes
	let lastCursorLine: number | null = null;
	// Track the previous cursor position for left/right detection
	let currentCursor: vscode.Position | null = null;

	// 1) Pre-generate earcons into cache ────────────────────────────
	preloadEverything(context);

	// 2) Build the unified audioMap ─────────────────────────────────────────────
	const audioMap = createAudioMap(context);

	// 3) Start LanguageClient ──────────────────────────────────────────────────
	const client = startLanguageClient(context);

	// 4) Register commands ───────────────────────────────────────────────────────
	registerEchoTest(context, client);
	registerWhereAmI(context, client);
	registerBreadcrumb(context, client);
	registerReadLineTokens(context, client, currentAbortController, audioMap);
	registerReadFunctionTokens(context, client, currentAbortController, audioMap);
	registerStopReadLineTokens(context);
	registerToggleTypingSpeech(context, client);
	registerReadCurrentLine(context);
	registerSymbolTree(context);
	registerSwitchPanel(context);
	registerFunctionList(context);
	registerFileTree(context);
	// registerTerminalReader(context);

	// When workspace is loaded, open Explorer, focus its tree, then read the file tree
	vscode.commands.executeCommand('workbench.view.explorer')
		.then(async () => {
			// Move focus into the file list
			await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
			// Finally read out the tree
			await vscode.commands.executeCommand('lipcoder.fileTree');
		});

	const diagCache = updateLineSeverity();


	// 5) Track Cursor Movement ────────────────────────────────────────────────────
	const indentLevels: Map<string, number> = new Map();
	const MAX_INDENT_UNITS = 5; // maximum nesting
	const MIN_INDENT_UNITS = 0;
	const editor = vscode.window.activeTextEditor!;
	// Initialize currentLineNum to avoid firing readLineTokens on activate
	currentLineNum = editor.selection.active.line;
	const tabSize = typeof editor.options.tabSize === 'number'
		? editor.options.tabSize
		: 4;  // fallback if somehow not a number

	// Initialize currentCursor to the active editor position
	currentCursor = editor.selection.active;

	// Only start reacting to cursor moves after a short delay (to skip editor-open events)
	let readyForCursor = false;
	setTimeout(() => {
		readyForCursor = true;
	}, 2000);

	// (Removed duplicate initialization of currentCursor using initialEditor)

	// 5) Track Cursor Movement ────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection((e) => {
			try {
				if (!readyForCursor) return; // Wait until initial load is complete
				if (e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard) return;

				const doc = e.textEditor.document;
				const scheme = doc.uri.scheme;

				if (scheme === 'output') return;
				if (scheme !== 'file') return; // Only file-system documents
				// Only real editor panes (not Output, Debug Console, etc.)
				if (e.textEditor.viewColumn === undefined) return;

				// Deduplicate rapid events
				const lineNum = e.selections[0].start.line;
				if (currentLineNum === lineNum) return;

				// Update and invoke
				currentLineNum = lineNum;
				log(`[cursor-log] line=${lineNum}`);
				vscode.commands.executeCommand('lipcoder.readLineTokens', e.textEditor)
					.then(undefined, err => console.error('readLineTokens failed:', err));

			} catch (err: any) {
				console.error('onDidChangeTextEditorSelection handler error:', err);
			}
		})
	);

	// Cancel file-tree reading on any arrow-based cursor movement in editor
	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(e => {
			if (
				e.kind === vscode.TextEditorSelectionChangeKind.Keyboard &&
				(e.selections.length === 1) &&
				isFileTreeReading()
			) {
				stopReadLineTokens();
			}
		})
	);

	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(e => {
			if (
				!readyForCursor ||
				e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard ||
				e.selections.length !== 1 ||
				isFileTreeReading()
			) return;

			const old = currentCursor; // you’ll need to track this before
			const sel = e.selections[0].active;
			// Detect left/right (same line, char moved by 1)
			if (old && sel.line === old.line && Math.abs(sel.character - old.character) === 1) {
				// It was a left/right arrow
				// 1) Stop everything
				stopReadLineTokens();
				stopPlayback();

				// 2) Speak new character
				const doc = e.textEditor.document;
				let char = '';
				if (sel.character > old.character) {
					// moved right: speak the char at old → sel
					char = doc.getText(new vscode.Range(old, sel));
				} else {
					// moved left: speak char at sel → old
					char = doc.getText(new vscode.Range(sel, old));
				}
				if (char) {
					speakToken(char);
				}
				// update tracked position and return—
				currentCursor = sel;
				return;
			}

			// Otherwise, your normal full-line logic...
			const lineNum = sel.line;
			if (currentLineNum === lineNum) {
				// Update cursor for next event
				currentCursor = e.selections[0].active;
				return;
			}
			currentLineNum = lineNum;
			vscode.commands.executeCommand('lipcoder.readLineTokens', e.textEditor);
			// Update cursor for next event
			currentCursor = e.selections[0].active;
		})
	);



	// Toggle between token and word reading mode
	let useWordMode = false;
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.toggleReadMode', () => {
			useWordMode = !useWordMode;
			vscode.window.showInformationMessage(
				`LipCoder: ${useWordMode ? 'Word' : 'Token'} reading mode`
			);
		})
	);

	// 6) Track Text Change ───────────────────────────────────────────────────────
	let skipNextIndent = false; // Flag to skip indent sound once after Enter

	vscode.workspace.onDidChangeTextDocument(async (event) => {
		if (!config.typingSpeechEnabled) return;

		const editor = vscode.window.activeTextEditor;
		if (!editor || event.document !== editor.document) return;

		const changes = event.contentChanges;
		if (changes.length === 0) return;

		if (useWordMode) {
			readWordTokens(event, changes);
		} else {
			readTextTokens(
				event,
				diagCache,
				changes,
				indentLevels,
				tabSize,
				skipNextIndent,
				MAX_INDENT_UNITS,
				audioMap
			);
		}
	});

	// Start polling for cursor-line changes once the language client is ready
	// (client as any).onReady().then(() => {
	// 	setInterval(() => {
	// 		const editor = vscode.window.activeTextEditor;
	// 		if (editor) {
	// 			const currentLine = editor.selection.active.line;
	// 			if (currentLine !== lastCursorLine) {
	// 				lastCursorLine = currentLine;
	// 				vscode.commands.executeCommand('lipcoder.readLineTokens')
	// 					.then(undefined, (err: any) => console.error('Error invoking readLineTokens:', err));
	// 			}
	// 		}
	// 	}, 500);
	// });


	// Custom Explorer navigation commands to stop file-tree narration
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.explorerUp', async () => {
			stopReadLineTokens();
			// Move selection up
			await vscode.commands.executeCommand('list.focusUp');
			// Copy selected resource path and read it
			await vscode.commands.executeCommand('copyFilePath');
			const filePath = await vscode.env.clipboard.readText();
			const name = path.basename(filePath);
			let isDir = false;
			try {
				const stat = fs.statSync(filePath);
				isDir = stat.isDirectory();
			} catch { }
			// Speak with folder voice or default
			if (isDir) {
				await speakToken(name, 'folder');
			} else {
				await speakToken(name);
			}
		}),
		vscode.commands.registerCommand('lipcoder.explorerDown', async () => {
			stopReadLineTokens();
			// Move selection down
			await vscode.commands.executeCommand('list.focusDown');
			// Copy selected resource path and read it
			await vscode.commands.executeCommand('copyFilePath');
			const filePath = await vscode.env.clipboard.readText();
			const name = path.basename(filePath);
			let isDir = false;
			try {
				const stat = fs.statSync(filePath);
				isDir = stat.isDirectory();
			} catch { }
			// Speak with folder voice or default
			if (isDir) {
				await speakToken(name, 'folder');
			} else {
				await speakToken(name);
			}
		})
	);
}

export function deactivate() {
	log('[extension] activate() completed');
}