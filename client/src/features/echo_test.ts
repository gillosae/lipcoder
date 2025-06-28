import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { LanguageClient } from 'vscode-languageclient/node';

export function registerEchoTest(context: ExtensionContext, client: LanguageClient) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.echoTest', async () => {
            try {
                log('[echoTest] invoked');
                const res = await client.sendRequest<{ text: string }>(
                    'lipcoder/echo',
                    { text: 'hello' }
                );
                log(`[echoTest] response: ${res.text}`);
                vscode.window.showInformationMessage(res.text);
            } catch (err) {
                vscode.window.showErrorMessage(`EchoTest failed: ${err}`);
            }
        })
    );
}