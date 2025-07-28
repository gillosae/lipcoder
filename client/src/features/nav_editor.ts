import * as vscode from 'vscode';
import { log } from '../utils';
import { isFileTreeReading } from './file_tree';
import { stopReading, getLineTokenReadingActive } from './stop_reading';
import { stopPlayback, speakTokenList, TokenChunk } from '../audio';
import { readWordTokens } from './read_word_tokens';
import { readTextTokens } from './read_text_tokens';
import { config } from '../config';
import { updateLineSeverity } from './line_severity';
import { shouldUseAudioMinimap, updateContinuousTone, resetSpeedTracking, cleanupAudioMinimap, isContinuousTonePlaying } from './audio_minimap';

let readyForCursor = false;
let cursorTimeout: NodeJS.Timeout | null = null;
let lastCursorMoveTime = 0;
let cursorIdleTimeout: NodeJS.Timeout | null = null;

/**
 * Clean up nav editor resources
 */
function cleanupNavEditor(): void {
    if (cursorTimeout) {
        clearTimeout(cursorTimeout);
        cursorTimeout = null;
    }
    if (cursorIdleTimeout) {
        clearTimeout(cursorIdleTimeout);
        cursorIdleTimeout = null;
    }
    readyForCursor = false;
    resetSpeedTracking(); // Reset audio minimap tracking
    cleanupAudioMinimap(); // Cleanup continuous tone generator
    log('[NavEditor] Cleaned up resources');
}

export function registerNavEditor(context: vscode.ExtensionContext, audioMap: any) {
    log('[NavEditor] Registering nav editor commands');
    
    const diagCache = updateLineSeverity();
    
    let currentLineNum = vscode.window.activeTextEditor?.selection.active.line ?? 0;
    let currentCursor = vscode.window.activeTextEditor?.selection.active ?? new vscode.Position(0, 0);
    
    cursorTimeout = setTimeout(() => { 
        readyForCursor = true; 
    }, 2000);

    // Indentation tracking (moved from extension)
    const indentLevels: Map<string, number> = new Map();
    const MAX_INDENT_UNITS = 5;
    const editor = vscode.window.activeTextEditor!;
    const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;

    // Toggle between token and word reading mode
    let useWordMode = false;
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.toggleReadMode', () => {
            useWordMode = !useWordMode;
            vscode.window.showInformationMessage(
                `LipCoder: ${useWordMode ? 'Word' : 'Token'} reading mode`
            );
        })
    );

    // Audio minimap configuration commands
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.toggleAudioMinimap', () => {
            config.audioMinimapEnabled = !config.audioMinimapEnabled;
            resetSpeedTracking(); // Reset tracking when toggling
            vscode.window.showInformationMessage(
                `LipCoder Audio Minimap: ${config.audioMinimapEnabled ? 'Enabled' : 'Disabled'}`
            );
        }),
        vscode.commands.registerCommand('lipcoder.setAudioMinimapSpeed', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'Set audio minimap speed threshold (lines per second)',
                placeHolder: 'e.g., 3.0 = trigger minimap when moving faster than 3 lines/sec',
                value: config.audioMinimapSpeedThreshold.toString(),
                validateInput: (value) => {
                    const val = parseFloat(value);
                    if (isNaN(val) || val <= 0) {
                        return 'Please enter a positive number';
                    }
                    if (val > 20) {
                        return 'Value too high, please use a reasonable threshold (1-20)';
                    }
                    return null;
                }
            });
            
            if (input) {
                config.audioMinimapSpeedThreshold = parseFloat(input);
                resetSpeedTracking(); // Reset tracking when changing threshold
                vscode.window.showInformationMessage(
                    `LipCoder Audio Minimap speed threshold set to ${config.audioMinimapSpeedThreshold} lines/sec`
                );
            }
        })
    );

    // Track text change for narration
    let skipNextIndent = false; // Flag to skip indent sound once after Enter
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (event) => {
            if (!config.typingSpeechEnabled) return;

            const editor = vscode.window.activeTextEditor;
            if (!editor || event.document !== editor.document) return;

            const changes = event.contentChanges;
            if (changes.length === 0) return;

            if (useWordMode) {
                readWordTokens(event, changes);
            } else {
                readTextTokens(
                    event,
                    diagCache,
                    changes,
                    indentLevels,
                    tabSize,
                    skipNextIndent,
                    MAX_INDENT_UNITS,
                    audioMap
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async (e) => {
            try {
                if (!readyForCursor) return;
                if (e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard) return;

                const doc = e.textEditor.document;
                const scheme = doc.uri.scheme;
                if (scheme === 'output' || scheme !== 'file') return;
                if (e.textEditor.viewColumn === undefined) return;

                const lineNum = e.selections[0].start.line;
                if (currentLineNum === lineNum) return;

                currentLineNum = lineNum;
                lastCursorMoveTime = Date.now();
                log(`[cursor-log] line=${lineNum}`);
                
                // Clear any existing idle timeout
                if (cursorIdleTimeout) {
                    clearTimeout(cursorIdleTimeout);
                    cursorIdleTimeout = null;
                }
                
                // Check if we should use audio minimap based on movement speed
                if (shouldUseAudioMinimap(lineNum, e.textEditor)) {
                    // Use audio minimap for fast navigation - update continuous tone
                    updateContinuousTone(e.textEditor);
                    
                    // Set an immediate idle detection timeout (75ms - very responsive)
                    cursorIdleTimeout = setTimeout(() => {
                        log('[NavEditor] Cursor idle detected - stopping continuous tone');
                        resetSpeedTracking(lineNum, e.textEditor); // Pass current line and editor
                    }, 75);
                } else {
                    // Only use regular line token reading if continuous tone is NOT playing
                    if (!isContinuousTonePlaying()) {
                        vscode.commands.executeCommand('lipcoder.readLineTokens', e.textEditor)
                            .then(undefined, err => console.error('readLineTokens failed:', err));
                    } else {
                        log('[NavEditor] Skipping readLineTokens - continuous tone is playing');
                    }
                }
            } catch (err: any) {
                console.error('onDidChangeTextEditorSelection handler error:', err);
            }
        }),
        // Reset speed tracking when changing editors
        vscode.window.onDidChangeActiveTextEditor(() => {
            resetSpeedTracking();
        }),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (
                e.kind === vscode.TextEditorSelectionChangeKind.Keyboard &&
                e.selections.length === 1 &&
                isFileTreeReading()
            ) {
                // Only stop reading if line token reading is not currently active
                if (!getLineTokenReadingActive()) {
                    stopReading();
                }
            }
        }),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (
                !readyForCursor ||
                e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard ||
                e.selections.length !== 1 ||
                isFileTreeReading()
            ) return;

            const old = currentCursor;
            const sel = e.selections[0].active;
            if (old && sel.line === old.line && Math.abs(sel.character - old.character) === 1) {
                // Only stop reading if line token reading is not currently active
                if (!getLineTokenReadingActive()) {
                    stopReading();
                    stopPlayback();
                }

                const doc = e.textEditor.document;
                const char = sel.character > old.character
                    ? doc.getText(new vscode.Range(old, sel))
                    : doc.getText(new vscode.Range(sel, old));

                if (char) {
                    speakTokenList([{ tokens: [char], category: undefined }]);
                }
                currentCursor = sel;
                return;
            }

            if (sel.line === currentLineNum) {
                currentCursor = sel;
                return;
            }
            currentLineNum = sel.line;
            vscode.commands.executeCommand('lipcoder.readLineTokens', e.textEditor);
            currentCursor = sel;
        })


    );

    // Track all event listeners for proper disposal
    const selectionListener1 = vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!readyForCursor) return;
        if (e.selections[0].isEmpty) {
            currentCursor = e.selections[0].active;
            currentLineNum = currentCursor.line;
        }
    });
    context.subscriptions.push(selectionListener1);

    const selectionListener2 = vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!readyForCursor) return;
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) return;
        const newPos = e.selections[0].active;
        if (newPos.line !== currentLineNum) {
            const line = activeEditor.document.lineAt(newPos.line);
            // Skip diagnostic severity check for now to avoid compilation errors
            // const severity = diagCache[newPos.line];
            // if (severity && severity !== vscode.DiagnosticSeverity.Hint) {
            //     const severityName = severity === vscode.DiagnosticSeverity.Error ? 'error' : 
            //                        severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'info';
            //     speakToken(`${severityName} on line ${newPos.line + 1}`);
            // }
        }
    });
    context.subscriptions.push(selectionListener2);

    const selectionListener3 = vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!readyForCursor) return;
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) return;
        const newPos = e.selections[0].active;
        if (newPos.line !== currentLineNum) {
            currentCursor = newPos;
            currentLineNum = newPos.line;
        }
    });
    context.subscriptions.push(selectionListener3);

    // Register cleanup disposal
    context.subscriptions.push({
        dispose: cleanupNavEditor
    });


}
