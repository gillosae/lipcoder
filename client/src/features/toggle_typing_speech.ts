import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { LanguageClient } from 'vscode-languageclient/node';
import { config } from '../config';

export function registerToggleTypingSpeech(context: ExtensionContext, client: LanguageClient) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.toggleTypingSpeech', () => {
            config.typingSpeechEnabled = !config.typingSpeechEnabled;
            const status = config.typingSpeechEnabled ? 'enabled' : 'disabled';
            vscode.window.showInformationMessage(`Typing speech is now ${status} `);
        })
    );
}