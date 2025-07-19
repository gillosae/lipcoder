import * as vscode from 'vscode';
import { setBackend, TTSBackend, stopPlayback, speakToken } from './audio';
import { createAudioMap } from './mapping';
import { preloadEverything } from './preload';
import { config, initConfig } from './config';
import { installDependencies } from './install_dependencies';
import { lipcoderLog } from './logger';

import { registerEchoTest } from './features/echo_test';
import { registerWhereAmI } from './features/where_am_i';
import { registerReadLineTokens } from './features/read_line_tokens';
import { loadDictionaryWord } from './features/word_logic';
import { registerStopReadLineTokens } from './features/stop_read_line_tokens';
import { registerToggleTypingSpeech } from './features/toggle_typing_speech';
import { startLanguageClient } from './language_client';
import { registerReadCurrentLine } from './features/current_line';
import { registerReadFunctionTokens } from './features/read_function_tokens';
import { registerBreadcrumb } from './features/breadcrumb';
import { registerSymbolTree } from './features/symbol_tree';
import { registerSwitchPanel } from './features/switch_panel';
import { registerFunctionList } from './features/function_list';
import { registerFileTree } from './features/file_tree';
import { registerTerminalReader } from './features/terminal';
import { registerFormatCode } from './features/format_code';
import { registerNavExplorer } from './features/nav_explorer';
import { registerNavEditor } from './features/nav_editor';
import { registerPlaySpeed } from './features/playspeed';

export async function activate(context: vscode.ExtensionContext) {
	// 0) Dependency installation in parallel ──────────────────────────────────────────────
	installDependencies().catch(err => console.error('installDependencies failed:', err));
	lipcoderLog.appendLine('🔍 Extension Host running on Electron v' + process.versions.electron);

	// 1) Provide the extension root to config ───────────────────────────────────────────
	initConfig(context);
	lipcoderLog.appendLine('[extension] activate() called');
	vscode.window.showInformationMessage('LipCoder: activate() called');

	// 2) TTS setup ───────────────────────────────────────────────────────────────────────
	await loadDictionaryWord();
	setBackend(TTSBackend.Silero); // Use Silero for TTS

	let currentAbortController: AbortController | null = null; // Module-scope cancellation controller

	// 3) Pre-generate earcons into cache ────────────────────────────
	preloadEverything(context);

	// 4) Build the unified audioMap ─────────────────────────────────────────────
	const audioMap = createAudioMap(context);

	// 5) Start LanguageClient ──────────────────────────────────────────────────
	const client = startLanguageClient(context);

	// 6) Register commands ───────────────────────────────────────────────────────
	registerEchoTest(context, client);
	registerWhereAmI(context, client);
	registerBreadcrumb(context, client);
	registerReadLineTokens(context, client, currentAbortController, audioMap);
	registerPlaySpeed(context);
	registerReadFunctionTokens(context, client, currentAbortController, audioMap);
	registerStopReadLineTokens(context);
	registerToggleTypingSpeech(context, client);
	registerReadCurrentLine(context);
	registerSymbolTree(context);
	registerSwitchPanel(context);
	registerFunctionList(context);
	registerFileTree(context);
	registerTerminalReader(context);
	registerFormatCode(context);
	registerNavExplorer(context);
	registerNavEditor(context, audioMap);
}

export function deactivate() {
	lipcoderLog.appendLine('[extension] activate() completed');
}