import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { LanguageClient } from 'vscode-languageclient/node';

export function registerStopReadLineTokens(context: ExtensionContext, client: LanguageClient, currentAbortController: AbortController | null) {
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.stopReadLineTokens', () => {
			if (currentAbortController) {
				currentAbortController.abort();
				currentAbortController = null;
				log('LipCoder speech stopped');
			}
		})
	);
}