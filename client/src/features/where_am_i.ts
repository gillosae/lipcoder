import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { LanguageClient } from 'vscode-languageclient/node';
import type { SymbolInformation } from 'vscode-languageserver-types';
import { speakToken } from '../audio';

export function registerWhereAmI(context: ExtensionContext, client: LanguageClient) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.whereAmI', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor!');
                return;
            }
            const uri = editor.document.uri.toString();

            try {
                const symbols = await client.sendRequest<SymbolInformation[]>(
                    'textDocument/documentSymbol',
                    { textDocument: { uri } }
                );

                const pos = editor.selection.active;
                const containing = symbols
                    .filter((s) => {
                        const r = s.location.range;
                        return (
                            (pos.line > r.start.line ||
                                (pos.line === r.start.line &&
                                    pos.character >= r.start.character)) &&
                            (pos.line < r.end.line ||
                                (pos.line === r.end.line &&
                                    pos.character <= r.end.character))
                        );
                    })
                    .sort((a, b) => {
                        const lenA =
                            a.location.range.end.line - a.location.range.start.line;
                        const lenB =
                            b.location.range.end.line - b.location.range.start.line;
                        return lenA - lenB;
                    });

                if (containing.length === 0) {
                    vscode.window.showInformationMessage('Outside of any symbol.');
                    await speakToken('You are outside of any symbol.');
                } else {
                    const symbol = containing[0];
                    const container = symbol.containerName
                        ? `${symbol.containerName} → `
                        : '';
                    const msg = `${container}${symbol.name}`;
                    vscode.window.showInformationMessage(`You are in: ${msg}`);
                    await speakToken(`You are in ${msg}`);
                }
            } catch (err) {
                vscode.window.showErrorMessage(`whereAmI failed: ${err}`);
            }
        })
    );
}