import * as vscode from 'vscode';
import * as path from 'path';
import { log } from '../utils';
import { playWave, speakTokenList, speakGPT, TokenChunk, clearAudioStoppingState, readInEspeak, stopThinkingAudio } from '../audio';
import { stopAllAudio, lineAbortController } from './stop_reading';
import { stopEarconPlayback } from '../earcon';

import { config } from '../config';
import type { DocumentSymbol } from 'vscode';

let autoTimer: NodeJS.Timeout | null = null;
let currentNavigationController: AbortController | null = null;

/**
 * Clean up function list resources
 */
function cleanupFunctionList(): void {
    if (autoTimer) {
        clearTimeout(autoTimer);
        clearInterval(autoTimer);
        autoTimer = null;
    }
    log('[FunctionList] Cleaned up resources');
}

export function registerFunctionList(context: vscode.ExtensionContext) {
    // Register cleanup function
    context.subscriptions.push({
        dispose: () => cleanupFunctionList()
    });
    
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
                    clearTimeout(autoTimer);
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
                    // Comprehensive audio stopping to handle all types including underbar sounds
                    log(`[FunctionList] Manual navigation - stopping audio for function: ${label}`);
                    
                    // Abort any previous navigation audio
                    if (currentNavigationController) {
                        currentNavigationController.abort();
                    }
                    currentNavigationController = new AbortController();
                    const navigationSignal = currentNavigationController.signal;
                    
                    stopAllAudio();
                    // Clear audio stopping state immediately to allow new audio to start right away
                    clearAudioStoppingState();
                    // Explicitly stop earcons to ensure they don't overlap
                    stopEarconPlayback();
                    
                    // Add small delay to ensure audio stopping is complete before starting new audio
                    setTimeout(async () => {
                        // Double-check that this navigation hasn't been aborted
                        if (navigationSignal.aborted) {
                            log(`[FunctionList] Navigation aborted, skipping audio for: ${label}`);
                            return;
                        }
                        
                        // Play indent earcon for nesting depth
                        const MAX_INDENT_UNITS = 5;
                        const idx = depth >= MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : depth;
                        const indentFile = path.join(config.earconPath(), `indent_${idx}.pcm`);
                        playWave(indentFile, { isEarcon: true, immediate: true }).catch(console.error);
                        
                        // Use readInEspeak for fast combined reading of function names with navigation signal
                        const functionName = label.replace(/\u00A0/g, ''); // Remove non-breaking spaces used for indentation
                        const chunks: TokenChunk[] = [{ 
                            tokens: [functionName], 
                            category: 'variable', // This triggers fast PCM processing with automatic word chunking
                            priority: 'high' // Ensure immediate navigation speech
                        }];
                        readInEspeak(chunks, navigationSignal).catch(console.error);
                    }, 200); // 200ms delay to ensure stopping is complete
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
                    
                    // Use readInEspeak for fast combined reading of confirmation message
                    const functionName = label.replace(/\u00A0/g, ''); // Remove non-breaking spaces
                    const chunks: TokenChunk[] = [
                        { tokens: ['moved', 'to', 'function'], category: undefined, priority: 'high' },
                        { tokens: [functionName], category: 'variable', priority: 'high' }, // Auto word chunking
                        { tokens: ['line', (line + 1).toString()], category: undefined, priority: 'high' }
                    ];
                    readInEspeak(chunks).catch(console.error);
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
                    speakGPT(`back to line ${pos.line + 1}`, lineAbortController.signal);
                }
                quickPick.dispose();
            });

            const MAX_INDENT_UNITS = 5;
            quickPick.show();
            // Ensure thinking earcon stops once the list is visible
            try { await stopThinkingAudio(); } catch {}
            speakGPT('functions', lineAbortController.signal);

            // Automatically walk through items, reading each every second
            // Wait a bit before starting auto-iteration to avoid simultaneous speech
            let idx = 0;
            autoTimer = setTimeout(() => {
                autoTimer = setInterval(() => {
                    // Check if aborted
                    if (lineAbortController.signal.aborted) {
                        log('[FunctionList] Auto navigation aborted');
                        clearInterval(autoTimer!);
                        autoTimer = null;
                        quickPick.hide();
                        return;
                    }
                    
                    if (idx >= quickPick.items.length) {
                        clearInterval(autoTimer!);
                        autoTimer = null;
                        // keep the QuickPick open for manual navigation
                        return;
                    }
                    // Comprehensive audio stopping to handle all types including underbar sounds
                    log(`[FunctionList] Auto navigation - stopping audio, moving to index ${idx}`);
                    stopAllAudio();
                    // Clear audio stopping state immediately to allow new audio to start right away
                    clearAudioStoppingState();
                    // Explicitly stop earcons to ensure they don't overlap
                    stopEarconPlayback();
                    
                    // Trigger next item immediately - stopping should be synchronous
                    quickPick.activeItems = [quickPick.items[idx]];
                    idx++;
                }, 1000);
            }, 1500); // Wait 1.5 seconds before starting auto-iteration
            
            // Clean up timer when quickPick is hidden
            quickPick.onDidHide(() => {
                if (autoTimer) {
                    clearTimeout(autoTimer);
                    clearInterval(autoTimer);
                    autoTimer = null;
                }
            });
        })
    );
    
    // Register cleanup disposal
    context.subscriptions.push({
        dispose: () => cleanupFunctionList()
    });
}