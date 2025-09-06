import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionContext } from 'vscode';
import type { DocumentSymbol } from 'vscode';
import { playWave, speakTokenList, speakGPT, TokenChunk, readInEspeak, clearAudioStoppingState } from '../audio';
import { config } from '../config';
import { stopReading, lineAbortController, stopAllAudio } from './stop_reading';
import { stopEarconPlayback } from '../earcon';
import { log } from '../utils';

let autoTimer: NodeJS.Timeout | null = null;

/**
 * Clean up symbol tree resources
 */
function cleanupSymbolTree(): void {
    if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
    }
    log('[SymbolTree] Cleaned up resources');
}

export function registerSymbolTree(context: ExtensionContext) {
    // Register cleanup function
    context.subscriptions.push({
        dispose: cleanupSymbolTree
    });
    
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.symbolTree', async (editorArg?: vscode.TextEditor) => {
            const editor = editorArg || vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('Open a file first!');
                speakGPT('Open a File First!', lineAbortController.signal);
                return;
            }
            const originalSelection = editor.selection;
            const uri = editor.document.uri;

            // 1) Fetch document symbols
            const tree = (await vscode.commands.executeCommand<DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            )) || [];

            // 2) Flatten into a list with label, depth, line
            const syms: { label: string; depth: number; line: number }[] = [];
            function walk(nodes: DocumentSymbol[], depth: number) {
                for (const node of nodes) {
                    const kind = vscode.SymbolKind[node.kind].toLowerCase();
                    const name = node.name;
                    const label = `${kind}: ${name}`;
                    syms.push({ label, depth, line: node.range.start.line });
                    if (node.children && node.children.length) {
                        walk(node.children, depth + 1);
                    }
                }
            }
            walk(tree, 0);

            if (syms.length === 0) {
                vscode.window.showInformationMessage('No symbols found in this file.');
                return;
            }

            // Setup QuickPick
            let accepted = false;
            let hideHandled = false;

            const quickPick = vscode.window.createQuickPick<{ label: string; depth: number; line: number }>();
            quickPick.items = syms.map(s => ({
                label: `${'\u00A0\u00A0'.repeat(s.depth)}${s.label}`,
                depth: s.depth,
                line: s.line
            }));
            quickPick.placeholder = 'Select a symbol…';

            // Handle movement
            quickPick.onDidChangeActive(async active => {
                // Stop auto-iteration if the user navigates manually
                if (autoTimer) {
                    clearInterval(autoTimer);
                    autoTimer = null;
                }
                const sel = active[0];
                if (sel) {
                    const { line, label, depth } = sel;
                    const pos = new vscode.Position(line, 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos));
                    
                    // Comprehensive audio stopping to handle all types including underbar sounds
                    log(`[SymbolTree] Manual navigation - stopping audio for symbol: ${label}`);
                    stopAllAudio();
                    // Clear audio stopping state immediately to allow new audio to start right away
                    clearAudioStoppingState();
                    // Explicitly stop earcons to ensure they don't overlap
                    stopEarconPlayback();
                    
                    // Add small delay to ensure audio stopping is complete before starting new audio
                    setTimeout(async () => {
                        // Double-check that audio is still stopped before starting new audio
                        if (lineAbortController.signal.aborted) {
                            log(`[SymbolTree] Abort signal detected, skipping audio for: ${label}`);
                            return;
                        }
                        
                        const MAX_INDENT_UNITS = 5;
                        const idx = depth >= MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : depth;
                        const indentFile = path.join(config.earconPath(), `indent_${idx}.pcm`);
                        playWave(indentFile, { isEarcon: true, immediate: true }).catch(console.error);
                        
                        // Use readInEspeak for fast combined reading of symbol names with abort signal
                        readInEspeak([{ tokens: [label], category: undefined, priority: 'high' }], lineAbortController.signal).catch(console.error);
                    }, 200); // 200ms delay to ensure stopping is complete
                }
            });

            // Accept
            quickPick.onDidAccept(() => {
                stopReading();
                accepted = true;
                const sel = quickPick.activeItems[0];
                if (sel) {
                    const { label, line, depth } = sel;
                    const MAX_INDENT_UNITS = 5;
                    const idx = depth >= MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : depth;
                    const indentFile = path.join(config.earconPath(), `indent_${idx}.pcm`);
                    playWave(indentFile, { isEarcon: true, immediate: true }).catch(console.error);
                    // Use readInEspeak for fast combined reading of acceptance message
                    readInEspeak([{ 
                        tokens: [`moved to symbol ${label} line ${line + 1}`], 
                        category: undefined,
                        priority: 'high'
                    }], lineAbortController.signal).catch(console.error);
                }
                quickPick.hide();
            });

            quickPick.onDidHide(() => {
                if (hideHandled) return;
                hideHandled = true;
                if (!accepted) {
                    const pos = originalSelection.active;
                    editor.selection = originalSelection;
                    editor.revealRange(new vscode.Range(pos, pos));
                    stopReading();
                    speakGPT(`back to line ${pos.line + 1}`, lineAbortController.signal);
                }
                quickPick.dispose();
            });

            stopReading();
            quickPick.show();
            speakGPT('symbols', lineAbortController.signal);

            // Auto-iterate
            let idx = 0;
            autoTimer = setInterval(() => {
                // Check if aborted
                if (lineAbortController.signal.aborted) {
                    log('[SymbolTree] Auto navigation aborted');
                    clearInterval(autoTimer!);
                    autoTimer = null;
                    quickPick.hide();
                    return;
                }
                
                if (idx >= quickPick.items.length) {
                    clearInterval(autoTimer!);
                    autoTimer = null;
                    return;
                }
                
                // Stop all audio before moving to next item
                stopAllAudio();
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
        dispose: cleanupSymbolTree
    });
}