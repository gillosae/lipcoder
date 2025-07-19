// import { stopFileTreeReading } from './file_tree';
// import { stopPlayback } from '../audio';
// import type { ExtensionContext } from 'vscode';
// import * as vscode from 'vscode';
// import { log } from '../utils';
// import { lineAbortController } from './read_line_tokens';

// /**
//  * Programmatically stop any in-progress line-read audio.
//  */
// export function stopReadLineTokens(): void {
// 	// Abort line-reading
// 	lineAbortController.abort();
// 	// Reset for next invocation
// 	// @ts-ignore: allow reassignment for export
// 	lineAbortController = new AbortController();
// 	// Also stop file-tree reading and any playback
// 	stopFileTreeReading();
// 	stopPlayback();
// 	log('LipCoder speech stopped');
// }

// export function registerStopReadLineTokens(context: ExtensionContext) {
// 	context.subscriptions.push(
// 		vscode.commands.registerCommand('lipcoder.stopReadLineTokens', () => {
// 			stopReadLineTokens();
// 		})
// 	);
// }


import { stopReadLineTokens as internalStopReadLineTokens } from './read_line_tokens';
import * as vscode from 'vscode';

export const stopReadLineTokens = internalStopReadLineTokens;

/**
 * Registers the stopReadLineTokens command with VS Code.
 */
export function registerStopReadLineTokens(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.stopReadLineTokens', () => {
			internalStopReadLineTokens();
		})
	);
}