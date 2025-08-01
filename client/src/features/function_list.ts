import * as vscode from 'vscode';
import * as path from 'path';
import { log } from '../utils';
import { playWave, speakTokenList, TokenChunk } from '../audio';
import { stopAllAudio } from './stop_reading';
import { config } from '../config';
import type { DocumentSymbol } from 'vscode';

let autoTimer: NodeJS.Timeout | null = null;

/**
 * Clean up function list resources
 */
function cleanupFunctionList(): void {
    if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
    }
    log('[FunctionList] Cleaned up resources');
}

export function registerFunctionList(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.functionList', async (editorArg?: vscode.TextEditor) => {
            const editor = editorArg || vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('Open a file first!');
                return;
            }
            const originalSelection = editor.selection;
            const uri = editor.document.uri;
            // 1) Get the document symbol tree
            const tree = (await vscode.commands.executeCommand<DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            )) || [];
            // 2) Collect all functions/methods with nesting depth and line number
            const funcs: { name: string; depth: number; line: number }[] = [];
            function walk(nodes: DocumentSymbol[], depth: number) {
                for (const node of nodes) {
                    if (
                        node.kind === vscode.SymbolKind.Function ||
                        node.kind === vscode.SymbolKind.Method
                    ) {
                        funcs.push({ name: node.name, depth, line: node.range.start.line });
                    }
                    if (node.children && node.children.length) {
                        walk(node.children, depth + 1);
                    }
                }
            }
            walk(tree, 0);
            if (funcs.length === 0) {
                vscode.window.showInformationMessage('No functions found in this file.');
                return;
            }
            // Auto-iterate handle for reading functions
            let accepted = false;
            let hideHandled = false;
            // Show QuickPick of functions
            const quickPick = vscode.window.createQuickPick<{ label: string; description: string; line: number; depth: number }>();
            quickPick.items = funcs.map(fn => ({
                // Indent the function name by two NBSPs per depth level
                label: `${'\u00A0\u00A0'.repeat(fn.depth)}${fn.name}`,
                description: '',
                line: fn.line,
                depth: fn.depth
            }));
            quickPick.placeholder = 'Select a function…';

            // When the selection changes, move cursor and read name
            quickPick.onDidChangeActive(async active => {
                // Stop auto-iteration if the user navigates manually
                if (autoTimer) {
                    clearInterval(autoTimer);
                    autoTimer = null;
                }
                const sel = active[0];
                if (sel) {
                    const { line, label, depth } = sel;
                    const editor = vscode.window.activeTextEditor!;
                    const pos = new vscode.Position(line, 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos));
                    stopAllAudio();
                    // Play indent earcon for nesting depth
                    const MAX_INDENT_UNITS = 5;
                    const idx = depth >= MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : depth;
                    const indentFile = path.join(config.earconPath(), `indent_${idx}.pcm`);
                    playWave(indentFile, { isEarcon: true, immediate: true }).catch(console.error);
                    speakTokenList([{ tokens: [label], category: undefined }]);
                }
            });

            // Close QuickPick when accepted or hidden
            quickPick.onDidAccept(async () => {
                accepted = true;
                const sel = quickPick.activeItems[0];
                if (sel) {
                    const { label, line, depth } = sel;
                    // Play indent earcon for nesting depth on accept as well
                    const MAX_INDENT_UNITS = 5;
                    const idx = depth >= MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : depth;
                    const indentFile = path.join(config.earconPath(), `indent_${idx}.pcm`);
                    playWave(indentFile, { isEarcon: true, immediate: true }).catch(console.error);
                    speakTokenList([{ tokens: [`moved to function ${label} line ${line + 1}`], category: undefined }]);
                }
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                if (hideHandled) {
                    return;
                }
                hideHandled = true;
                if (!accepted) {
                    const pos = originalSelection.active;
                    editor.selection = originalSelection;
                    editor.revealRange(new vscode.Range(pos, pos));
                    speakTokenList([{ tokens: [`back to line ${pos.line + 1}`], category: undefined }]);
                }
                quickPick.dispose();
            });

            const MAX_INDENT_UNITS = 5;
            quickPick.show();
            speakTokenList([{ tokens: ['functions'], category: undefined }]);

            // Automatically walk through items, reading each every second
            let idx = 0;
            autoTimer = setInterval(() => {
                if (idx >= quickPick.items.length) {
                    clearInterval(autoTimer!);
                    autoTimer = null;
                    // keep the QuickPick open for manual navigation
                    return;
                }
                quickPick.activeItems = [quickPick.items[idx]];
                idx++;
            }, 1000);
            
            // Clean up timer when quickPick is hidden
            quickPick.onDidHide(() => {
                if (autoTimer) {
                    clearInterval(autoTimer);
                    autoTimer = null;
                }
            });
        })
    );
    
    // Register cleanup disposal
    context.subscriptions.push({
        dispose: cleanupFunctionList
    });
}