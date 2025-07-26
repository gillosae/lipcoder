// Global controller for line-read cancellation
export let lineAbortController = new AbortController();

import { stopPlayback } from '../audio';
import * as vscode from 'vscode';

export function stopReading(): void {
	stopPlayback();
	// abort and reset the line reader controller
	lineAbortController.abort();
	// @ts-ignore
	lineAbortController = new AbortController();
}

export function registerStopReading(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.stopReadLineTokens', () => {
			stopReading();
		})
	);
}