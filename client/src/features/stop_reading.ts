// Global controller for line-read cancellation
export let lineAbortController = new AbortController();

import { stopPlayback } from '../audio';
import * as vscode from 'vscode';

// Track if line token reading is currently active
let lineTokenReadingActive = false;

export function setLineTokenReadingActive(active: boolean): void {
	lineTokenReadingActive = active;
}

export function getLineTokenReadingActive(): boolean {
	return lineTokenReadingActive;
}

export function stopReading(): void {
	stopPlayback();
	// abort and reset the line reader controller
	lineAbortController.abort();
	// @ts-ignore
	lineAbortController = new AbortController();
	setLineTokenReadingActive(false);
}

export function registerStopReading(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.stopReadLineTokens', () => {
			stopReading();
		})
	);
}