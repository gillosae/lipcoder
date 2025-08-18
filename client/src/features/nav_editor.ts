import * as vscode from 'vscode';
import { log } from '../utils';
import { isFileTreeReading } from './file_tree';
import { stopReading, getLineTokenReadingActive, stopForCursorMovement, stopAllAudio } from './stop_reading';
import { speakTokenList, TokenChunk } from '../audio';
import { readWordTokens } from './read_word_tokens';
import { readTextTokens } from './read_text_tokens';
import { config } from '../config';
import { updateLineSeverity } from './line_severity';
import { shouldUseAudioMinimap, updateContinuousTone, resetSpeedTracking, cleanupAudioMinimap, isContinuousTonePlaying } from './audio_minimap';

let readyForCursor = false;
let cursorTimeout: NodeJS.Timeout | null = null;
let lastCursorMoveTime = 0;

// Undo detection system to prevent TTS flooding
let undoDetectionTimeout: NodeJS.Timeout | null = null;
let isUndoOperation = false;
let lastUndoTime = 0;
const UNDO_DETECTION_WINDOW_MS = 500; // 500ms window to detect undo operations
let suppressAutomaticReading = false; // Flag to suppress automatic text reading
let cursorIdleTimeout: NodeJS.Timeout | null = null;
let pendingLineReadTimeout: NodeJS.Timeout | null = null;

/**
 * Detect if the current text changes are likely from an undo operation
 * Undo operations typically have specific patterns:
 * - Multiple large changes in a single event
 * - Changes that span multiple lines
 * - Large deletions followed by insertions
 */
function detectUndoOperation(changes: readonly vscode.TextDocumentContentChangeEvent[]): boolean {
    if (changes.length === 0) return false;
    
    // Pattern 1: Multiple changes in single event (common in undo)
    if (changes.length > 3) {
        log(`[UndoDetection] Multiple changes detected (${changes.length}) - likely undo`);
        return true;
    }
    
    // Pattern 2: Large single change (more than 50 characters or multiple lines)
    for (const change of changes) {
        const isLargeChange = change.text.length > 50 || change.rangeLength > 50;
        const isMultiLineChange = change.text.includes('\n') || 
                                 (change.range.end.line - change.range.start.line) > 0;
        
        if (isLargeChange || isMultiLineChange) {
            log(`[UndoDetection] Large/multiline change detected - likely undo (text: ${change.text.length} chars, range: ${change.rangeLength})`);
            return true;
        }
    }
    
    // Pattern 3: Rapid sequence of changes (if called multiple times quickly)
    const now = Date.now();
    if (now - lastUndoTime < 100) { // Within 100ms of last undo detection
        log(`[UndoDetection] Rapid change sequence detected - likely continued undo`);
        return true;
    }
    
    return false;
}

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
    if (pendingLineReadTimeout) {
        clearTimeout(pendingLineReadTimeout);
        pendingLineReadTimeout = null;
    }
    if (undoDetectionTimeout) {
        clearTimeout(undoDetectionTimeout);
        undoDetectionTimeout = null;
    }
    readyForCursor = false;
    resetSpeedTracking(); // Reset audio minimap tracking
    cleanupAudioMinimap();     // Cleanup continuous tone generator
    log('[NavEditor] Cleaned up resources');
}

/**
 * Suppress automatic text reading (e.g., during vibe coding operations)
 */
export function suppressAutomaticTextReading(): void {
    suppressAutomaticReading = true;
    log('[NavEditor] Automatic text reading suppressed');
}

/**
 * Resume automatic text reading
 */
export function resumeAutomaticTextReading(): void {
    suppressAutomaticReading = false;
    log('[NavEditor] Automatic text reading resumed');
}

/**
 * Reset undo detection state (useful for debugging or manual reset)
 */
export function resetUndoDetection(): void {
    isUndoOperation = false;
    lastUndoTime = 0;
    if (undoDetectionTimeout) {
        clearTimeout(undoDetectionTimeout);
        undoDetectionTimeout = null;
    }
    log('[NavEditor] Undo detection state reset');
}

export function registerNavEditor(context: vscode.ExtensionContext, audioMap: any) {
    log('[NavEditor] Registering nav editor commands');
    
    const diagCache = updateLineSeverity();
    
    let currentLineNum = vscode.window.activeTextEditor?.selection.active.line ?? 0;
    let currentCursor = vscode.window.activeTextEditor?.selection.active ?? new vscode.Position(0, 0);

    // Track recent typing to prevent double audio on cursor movement
    let lastTypingTime = 0;
    const TYPING_DETECTION_WINDOW_MS = 100; // Consider cursor movements within 100ms of typing as typing-related
    
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
        vscode.commands.registerCommand('lipcoder.toggleCursorLineReading', () => {
            config.cursorLineReadingEnabled = !config.cursorLineReadingEnabled;
            vscode.window.showInformationMessage(
                `LipCoder Cursor Line Reading: ${config.cursorLineReadingEnabled ? 'Enabled' : 'Disabled'}`
            );
        }),
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
        vscode.workspace.onDidChangeTextDocument((e) => {
            // Track typing time to prevent double audio
            lastTypingTime = Date.now();
            
            // Skip automatic reading if suppressed (e.g., during vibe coding)
            if (suppressAutomaticReading) return;
            
            // Detect undo operations and suppress TTS to prevent flooding
            const changes = e.contentChanges;
            if (changes.length === 0) return;
            
            // Detect potential undo operation based on change patterns
            const isLikelyUndo = detectUndoOperation(changes);
            if (isLikelyUndo) {
                isUndoOperation = true;
                lastUndoTime = Date.now();
                log('[NavEditor] Undo operation detected - suppressing TTS to prevent flooding');
                
                // Clear any existing timeout
                if (undoDetectionTimeout) {
                    clearTimeout(undoDetectionTimeout);
                }
                
                // Set timeout to resume normal TTS after undo window
                undoDetectionTimeout = setTimeout(() => {
                    isUndoOperation = false;
                    log('[NavEditor] Undo detection window expired - resuming normal TTS');
                }, UNDO_DETECTION_WINDOW_MS);
                
                return; // Skip TTS during undo operations
            }
            
            // Skip if we're still in undo detection window
            if (isUndoOperation) {
                const timeSinceUndo = Date.now() - lastUndoTime;
                if (timeSinceUndo < UNDO_DETECTION_WINDOW_MS) {
                    log('[NavEditor] Still in undo detection window - suppressing TTS');
                    return;
                }
            }
            
            if (!config.typingSpeechEnabled) return;
            const editor = vscode.window.activeTextEditor;
            if (!editor || e.document !== editor.document) return;

            if (useWordMode) {
                readWordTokens(e, changes);
            } else {
                readTextTokens(
                    e,
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

                // Skip audio minimap processing if this cursor movement was caused by recent typing
                const timeSinceTyping = Date.now() - lastTypingTime;
                const isTypingRelated = timeSinceTyping < TYPING_DETECTION_WINDOW_MS;
                
                if (!isTypingRelated) {
                    // IMMEDIATELY stop all audio when cursor moves to new line (only for navigation)
                    stopForCursorMovement();
                    // Additional aggressive stop to prevent audio bleeding
                    stopAllAudio();
                    
                    // Cancel any pending line read from previous cursor movement
                    if (pendingLineReadTimeout) {
                        clearTimeout(pendingLineReadTimeout);
                        pendingLineReadTimeout = null;
                    }
                }

                currentLineNum = lineNum;
                lastCursorMoveTime = Date.now();
                log(`[cursor-log] line=${lineNum}, typing-related=${isTypingRelated}`);
                
                // Clear any existing idle timeout
                if (cursorIdleTimeout) {
                    clearTimeout(cursorIdleTimeout);
                    cursorIdleTimeout = null;
                }
                
                // Only check audio minimap for actual navigation, not typing
                if (!isTypingRelated && shouldUseAudioMinimap(lineNum, e.textEditor)) {
                    // Use audio minimap for fast navigation - update continuous tone
                    updateContinuousTone(e.textEditor);
                    
                    // Set an immediate idle detection timeout (75ms - very responsive)
                    cursorIdleTimeout = setTimeout(() => {
                        log('[NavEditor] Cursor idle detected - stopping continuous tone');
                        resetSpeedTracking(lineNum, e.textEditor); // Pass current line and editor
                    }, 75);
                } else if (!isTypingRelated && config.cursorLineReadingEnabled) {
                    // Only use regular line token reading if continuous tone is NOT playing and not typing
                    if (!isContinuousTonePlaying()) {
                        // Add a delay to ensure previous audio is fully stopped and cleaned up
                        pendingLineReadTimeout = setTimeout(() => {
                            pendingLineReadTimeout = null;
                            // Double-check that we're still on the same line and should read
                            if (e.textEditor === vscode.window.activeTextEditor && 
                                e.textEditor.selection.active.line === lineNum) {
                                vscode.commands.executeCommand('lipcoder.readLineTokens', e.textEditor)
                                    .then(undefined, err => console.error('readLineTokens failed:', err));
                            }
                        }, 100); // 100ms delay to prevent audio bleeding
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
                // Skip if this cursor movement was caused by recent typing (prevents double audio)
                const timeSinceTyping = Date.now() - lastTypingTime;
                if (timeSinceTyping < TYPING_DETECTION_WINDOW_MS) {
                    currentCursor = sel;
                    return;
                }
                
                // Only stop reading if line token reading is not currently active
                if (!getLineTokenReadingActive()) {
                    stopAllAudio(); // Use centralized stopping system
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

    // Register reset undo detection command for debugging
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.resetUndoDetection', resetUndoDetection)
    );

    // Register cleanup disposal
    context.subscriptions.push({
        dispose: cleanupNavEditor
    });


}
