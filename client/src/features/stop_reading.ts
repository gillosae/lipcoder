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