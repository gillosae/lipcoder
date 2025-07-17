import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import type { SymbolInformation } from 'vscode-languageserver-types';
import type { DocumentSymbol } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { speakToken } from '../audio';
import { log } from '../utils';

export function registerBreadcrumb(
    context: ExtensionContext,
    client: LanguageClient
) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.breadcrumb', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor!');
                return;
            }

            // Build the file‐path breadcrumb
            const uri = editor.document.uri.toString();
            const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
            const breadcrumb = relativePath.split(/[\\/\\\\]/).join(' ');

            // Try to locate the smallest enclosing symbol
            let namePart = '';
            try {
                // Fetch symbols via VS Code API (works for all languages, including Python)
                const raw = (await vscode.commands.executeCommand<
                    (SymbolInformation | DocumentSymbol)[]
                >(
                    'vscode.executeDocumentSymbolProvider',
                    editor.document.uri
                )) || [];
                // Flatten into SymbolInformation[]
                const symbols: SymbolInformation[] = [];
                function collect(item: any) {
                    if (item.location) {
                        symbols.push(item as SymbolInformation);
                    } else if (item.range && item.selectionRange) {
                        symbols.push({
                            name: item.name,
                            kind: item.kind,
                            location: { uri, range: item.range },
                        } as SymbolInformation);
                        if (Array.isArray(item.children)) {
                            item.children.forEach(collect);
                        }
                    }
                }
                raw.forEach(collect);
                // Find symbols enclosing cursor
                const pos = editor.selection.active;
                const containing = symbols
                    .filter(s => {
                        const r = s.location.range;
                        return (
                            (pos.line > r.start.line ||
                                (pos.line === r.start.line && pos.character >= r.start.character)) &&
                            (pos.line < r.end.line ||
                                (pos.line === r.end.line && pos.character <= r.end.character))
                        );
                    })
                    .sort((a, b) => {
                        const lenA = a.location.range.end.line - a.location.range.start.line;
                        const lenB = b.location.range.end.line - b.location.range.start.line;
                        return lenA - lenB;
                    });
                if (containing.length > 0) {
                    namePart = containing[0].name;
                }
            } catch (err) {
                log(`breadcrumb symbol lookup failed: ${err}`);
            }

            // Show & speak the result
            const message =
                namePart.length > 0
                    ? `You are in ${breadcrumb} ${namePart} function`
                    : `You are in ${breadcrumb}`;
            vscode.window.showInformationMessage(message);
            try {
                await speakToken(message);
            } catch {
                // ignore TTS errors
            }
        })
    );
}