import * as vscode from 'vscode';
import { log } from '../utils';
import { isFileTreeReading } from './file_tree';
import { stopReading, getLineTokenReadingActive, stopForCursorMovement, stopAllAudio, lineAbortController, setLineTokenReadingActive } from './stop_reading';
import { speakTokenList, TokenChunk } from '../audio';
import { readWordTokens } from './read_word_tokens';
import { readTextTokens, getReadTextTokensActive } from './read_text_tokens';
import { config } from '../config';
import { updateLineSeverity } from './line_severity';
import { shouldSuppressReadingEnhanced } from './debug_console_detection';
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
        
        // IMPORTANT: Don't treat simple Enter presses as undo operations
        // Enter creates a newline, but it's normal typing, not an undo
        const isSimpleEnter = change.text === '\n' || change.text.startsWith('\n');
        const isMultiLineChange = change.text.includes('\n') || 
                                 (change.range.end.line - change.range.start.line) > 0;
        
        // Only consider it an undo if it's a large change AND not a simple Enter press
        if (isLargeChange || (isMultiLineChange && !isSimpleEnter)) {
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
    
    // Set readyForCursor immediately - no delay needed for cursor movement
    readyForCursor = true;

    // Indentation tracking (moved from extension)
    const indentLevels: Map<string, number> = new Map();
    const MAX_INDENT_UNITS = 5;
    const editor = vscode.window.activeTextEditor;
    const tabSize = editor && editor.options && typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;

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
    let skipNextIndentObj = { value: false }; // Flag to skip indent sound once after Enter

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (e) => {
            // Track typing time to prevent double audio
            lastTypingTime = Date.now();
            
            // Skip settings.json and other VS Code configuration files
            const fileName = e.document.fileName;
            if (fileName.includes('settings.json') || 
                fileName.includes('.vscode/') ||
                fileName.includes('Application Support/Code/User/') ||
                fileName.includes('Code/User/') ||
                e.document.uri.scheme !== 'file' ||
                e.document.languageId === 'jsonc') {
                log(`[NavEditor] Skipping VS Code config file: ${fileName}`);
                return;
            }
            
            log(`[NavEditor] Document change detected: ${e.contentChanges.map(c => `"${c.text}"`).join(', ')}`);
            
            // Skip automatic reading if suppressed (e.g., during vibe coding)
            if (suppressAutomaticReading) {
                log(`[NavEditor] Skipping - suppressAutomaticReading is true`);
                return;
            }
            
            // Check if we should suppress reading for debug console or other panels
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && shouldSuppressReadingEnhanced(activeEditor)) {
                log(`[NavEditor] Skipping - shouldSuppressReadingEnhanced returned true`);
                return;
            }
            
            // Detect undo operations and suppress TTS to prevent flooding
            const changes = e.contentChanges;
            if (changes.length === 0) {
                log(`[NavEditor] Skipping - no content changes`);
                return;
            }
            
            // Detect potential undo operation based on change patterns
            const isLikelyUndo = detectUndoOperation(changes);
            if (isLikelyUndo) {
                isUndoOperation = true;
                lastUndoTime = Date.now();
                log('[NavEditor] Undo operation detected - playing undo sound and suppressing TTS');
                
                // Play "Undo" sound
                try {
                    await speakTokenList([{
                        tokens: ['Undo'],
                        category: 'comment_text'
                    }]);
                } catch (error) {
                    log(`[NavEditor] Error playing undo sound: ${error}`);
                }
                
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
            
            if (!config.typingSpeechEnabled) {
                log(`[NavEditor] Skipping - typingSpeechEnabled is false`);
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                log(`[NavEditor] Skipping - no active editor`);
                return;
            }
            if (e.document !== editor.document) {
                log(`[NavEditor] Skipping - document mismatch. Event doc: ${e.document.fileName}, Active doc: ${editor.document.fileName}`);
                return;
            }
            
            log(`[NavEditor] All checks passed, proceeding to token reading...`);

            if (useWordMode) {
                log(`[NavEditor] Using WORD mode for typing: ${changes.map(c => c.text).join('')}`);
                readWordTokens(e, changes);
            } else {
                log(`[NavEditor] Using TOKEN mode for typing: ${changes.map(c => c.text).join('')}`);
                readTextTokens(
                    e,
                    diagCache,
                    changes,
                    indentLevels,
                    tabSize,
                    skipNextIndentObj,
                    MAX_INDENT_UNITS,
                    audioMap
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async (e) => {
            try {
                log(`[NavEditor] 🔍 CURSOR SELECTION CHANGE - readyForCursor: ${readyForCursor}, kind: ${e.kind}, selections: ${e.selections.length}`);
                
                if (!readyForCursor) {
                    log(`[NavEditor] ❌ BLOCKED - readyForCursor is false`);
                    return;
                }
                if (e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard) {
                    log(`[NavEditor] ❌ BLOCKED - not keyboard selection (kind: ${e.kind})`);
                    return;
                }
                
                // PRIORITY: Always process cursor movements that change lines, regardless of other conditions
                const newLineNum = e.selections[0].start.line;
                const isLineChange = currentLineNum !== newLineNum;
                log(`[NavEditor] 📍 Line check: current=${currentLineNum}, new=${newLineNum}, isLineChange=${isLineChange}`);
                
                if (isLineChange) {
                    log(`[NavEditor] ✅ PRIORITY: Line change detected ${currentLineNum} → ${newLineNum}`);
                }

                // Check if we should suppress reading for debug console or other panels
                if (shouldSuppressReadingEnhanced(e.textEditor)) {
                    log('[NavEditor] ❌ BLOCKED - shouldSuppressReadingEnhanced returned true');
                    return;
                }

                const doc = e.textEditor.document;
                const scheme = doc.uri.scheme;
                log(`[NavEditor] 📄 Document check: scheme=${scheme}, viewColumn=${e.textEditor.viewColumn}`);
                
                if (scheme === 'output' || scheme !== 'file') {
                    log(`[NavEditor] ❌ BLOCKED - invalid scheme: ${scheme}`);
                    return;
                }
                if (e.textEditor.viewColumn === undefined) {
                    log(`[NavEditor] ❌ BLOCKED - viewColumn is undefined`);
                    return;
                }

                const lineNum = newLineNum; // Use the already calculated line number
                if (!isLineChange) {
                    log(`[NavEditor] ❌ BLOCKED - no line change detected`);
                    return; // Skip if no line change detected
                }

                // Skip audio minimap processing if this cursor movement was caused by recent typing
                const timeSinceTyping = Date.now() - lastTypingTime;
                const isTypingRelated = timeSinceTyping < TYPING_DETECTION_WINDOW_MS;
                log(`[NavEditor] ⏱️ Timing check: timeSinceTyping=${timeSinceTyping}ms, isTypingRelated=${isTypingRelated}`);
                
                if (!isTypingRelated) {
                    // ULTRA-AGGRESSIVE STOP: Stop all audio immediately when cursor moves to new line
                    // This is especially important for Korean TTS which can take longer to generate
                    log('[NavEditor] CURSOR MOVEMENT DETECTED - ULTRA-AGGRESSIVE AUDIO STOP');
                    
                    // 1. Cancel any pending line read from previous cursor movement FIRST (no longer needed with immediate reading)
                    if (pendingLineReadTimeout) {
                        clearTimeout(pendingLineReadTimeout);
                        pendingLineReadTimeout = null;
                        log('[NavEditor] Cancelled pending line read timeout');
                    }
                    
                    // 2. Force clear Korean TTS protection to allow immediate stopping
                    (global as any).koreanTTSActive = false;
                    log('[NavEditor] Cleared Korean TTS protection for cursor movement');
                    
                    // 3. Set line token reading as inactive BEFORE stopping audio
                    setLineTokenReadingActive(false);
                    log('[NavEditor] Set line token reading inactive');
                    
                    // 4. Stop all audio systems with maximum aggression
                    stopForCursorMovement();
                    stopAllAudio();
                    stopForCursorMovement(); // Call twice for safety
                    
                    // 5. Force abort the line reading controller immediately
                    if (lineAbortController && !lineAbortController.signal.aborted) {
                        lineAbortController.abort();
                        log('[NavEditor] Force aborted line reading controller');
                    }
                    
                    // 6. Additional safety: Clear any audio player state
                    try {
                        const { audioPlayer } = require('../audio');
                        if (audioPlayer && audioPlayer.stopCurrentPlayback) {
                            audioPlayer.stopCurrentPlayback(true); // Force immediate stop
                            log('[NavEditor] Force stopped audio player');
                        }
                    } catch (err) {
                        // Ignore errors in emergency stop
                    }
                    
                    log('[NavEditor] ULTRA-AGGRESSIVE STOP COMPLETE - All audio systems terminated');
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
                    log(`[NavEditor] 🎯 Checking line reading conditions: !isTypingRelated=${!isTypingRelated}, cursorLineReadingEnabled=${config.cursorLineReadingEnabled}`);
                    
                    // Check if automatic reading is suppressed (e.g., during vibe coding)
                    if (suppressAutomaticReading) {
                        log('[NavEditor] ❌ BLOCKED - suppressAutomaticReading is true');
                        return;
                    }
                    
                    // Only use regular line token reading if continuous tone is NOT playing and not typing
                    const continuousTonePlaying = isContinuousTonePlaying();
                    log(`[NavEditor] 🔊 Audio check: continuousTonePlaying=${continuousTonePlaying}`);
                    
                    if (!continuousTonePlaying) {
                        // IMMEDIATE line reading for cursor movement - no delay to prevent gaps
                        log('[NavEditor] 🚀 STARTING IMMEDIATE line reading after cursor movement');
                        vscode.commands.executeCommand('lipcoder.readLineTokens', e.textEditor)
                            .then(() => {
                                log('[NavEditor] ✅ readLineTokens command completed successfully');
                            }, err => {
                                console.error('[NavEditor] ❌ readLineTokens failed:', err);
                            });
                    } else {
                        log('[NavEditor] ❌ BLOCKED - continuous tone is playing');
                    }
                } else {
                    log(`[NavEditor] ❌ BLOCKED - conditions not met: isTypingRelated=${isTypingRelated}, cursorLineReadingEnabled=${config.cursorLineReadingEnabled}`);
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
                // Check if we should suppress reading for debug console or other panels
                if (shouldSuppressReadingEnhanced(e.textEditor)) {
                    return;
                }
                
                // Only stop reading if line token reading is not currently active
                if (!getLineTokenReadingActive()) {
                    stopReading();
                }
            }
        }),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (
                !readyForCursor ||
                (e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard && e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) ||
                e.selections.length !== 1 ||
                isFileTreeReading()
            ) {
                log(`[NavEditor] Skipping cursor navigation - readyForCursor: ${readyForCursor}, kind: ${e.kind}, selections: ${e.selections.length}, fileTreeReading: ${isFileTreeReading()}`);
                return;
            }

            // Check if we should suppress reading for debug console or other panels
            if (shouldSuppressReadingEnhanced(e.textEditor)) {
                log(`[NavEditor] Skipping cursor navigation - suppressed for debug console`);
                return;
            }

            const old = currentCursor;
            const sel = e.selections[0].active;
            if (old && sel.line === old.line && Math.abs(sel.character - old.character) === 1) {
                // Skip if this cursor movement was caused by recent typing (prevents double audio)
                const timeSinceTyping = Date.now() - lastTypingTime;
                if (timeSinceTyping < TYPING_DETECTION_WINDOW_MS) {
                    log(`[NavEditor] Skipping cursor navigation - recent typing detected (${timeSinceTyping}ms ago)`);
                    currentCursor = sel;
                    return;
                }
                
                // Only stop reading if line token reading is not currently active
                // IMPORTANT: Don't stop audio if we just started line reading from cursor movement
                if (!getLineTokenReadingActive()) {
                    // Additional check: Don't stop if this is very recent cursor movement (within 100ms)
                    const timeSinceLastCursorMove = Date.now() - lastCursorMoveTime;
                    if (timeSinceLastCursorMove > 100) {
                        stopAllAudio(); // Use centralized stopping system
                        log(`[NavEditor] Stopped audio for character navigation (${timeSinceLastCursorMove}ms since last cursor move)`);
                    } else {
                        log(`[NavEditor] Skipping audio stop - recent cursor movement detected (${timeSinceLastCursorMove}ms ago)`);
                    }
                }

                const doc = e.textEditor.document;
                const char = sel.character > old.character
                    ? doc.getText(new vscode.Range(old, sel))
                    : doc.getText(new vscode.Range(sel, old));

                if (char) {
                    // Check if this cursor movement is typing-related to avoid double audio
                    const timeSinceTyping = Date.now() - lastTypingTime;
                    const isTypingRelated = timeSinceTyping < TYPING_DETECTION_WINDOW_MS;
                    const isReadTextTokensProcessing = getReadTextTokensActive();
                    
                    if (isTypingRelated || isReadTextTokensProcessing) {
                        log(`[NavEditor] ✅ SKIPPED character navigation audio for "${char}" - typing-related: ${isTypingRelated} (${timeSinceTyping}ms ago), readTextTokens active: ${isReadTextTokensProcessing}`);
                    } else {
                        log(`[NavEditor] 🔊 PLAYING character navigation audio for: "${char}" (${timeSinceTyping}ms since typing, readTextTokens active: ${isReadTextTokensProcessing})`);
                        speakTokenList([{ tokens: [char], category: undefined }]);
                    }
                } else {
                    log(`[NavEditor] No character found for navigation`);
                }
                currentCursor = sel;
                return;
            }

            if (sel.line === currentLineNum) {
                currentCursor = sel;
                return;
            }

            // ULTRA-AGGRESSIVE STOP for line change on ANY selection kind (keyboard or mouse)
            try {
                const timeSinceTyping = Date.now() - lastTypingTime;
                const isTypingRelated = timeSinceTyping < TYPING_DETECTION_WINDOW_MS;
                log(`[NavEditor] (Mouse/Keyboard) Line change detected → aggressive stop. typingRelated=${isTypingRelated}`);

                if (pendingLineReadTimeout) {
                    clearTimeout(pendingLineReadTimeout);
                    pendingLineReadTimeout = null;
                    log('[NavEditor] Cancelled pending line read timeout (mouse/keyboard)');
                }

                (global as any).koreanTTSActive = false;
                setLineTokenReadingActive(false);

                // Stop all audio systems immediately
                stopForCursorMovement();
                stopAllAudio();
                stopForCursorMovement();

                // Abort the controller if still active
                if (lineAbortController && !lineAbortController.signal.aborted) {
                    lineAbortController.abort();
                    log('[NavEditor] Force aborted line reading controller (mouse/keyboard)');
                }

                // Extra safety: stop audio player directly
                try {
                    const { audioPlayer } = require('../audio');
                    if (audioPlayer && audioPlayer.stopCurrentPlayback) {
                        audioPlayer.stopCurrentPlayback(true);
                        log('[NavEditor] Force stopped audio player (mouse/keyboard)');
                    }
                } catch {}
            } catch (stopErr) {
                // Ignore errors during stop
            }

            currentLineNum = sel.line;
            vscode.commands.executeCommand('lipcoder.readLineTokens', e.textEditor);
            currentCursor = sel;
        })


    );

    // Track all event listeners for proper disposal
    const selectionListener1 = vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!readyForCursor) return;
        
        // Check if we should suppress reading for debug console or other panels
        if (shouldSuppressReadingEnhanced(e.textEditor)) {
            return;
        }
        
        if (e.selections[0].isEmpty) {
            currentCursor = e.selections[0].active;
            currentLineNum = currentCursor.line;
        }
    });
    context.subscriptions.push(selectionListener1);

    const selectionListener2 = vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!readyForCursor) return;
        
        // Check if we should suppress reading for debug console or other panels
        if (shouldSuppressReadingEnhanced(e.textEditor)) {
            return;
        }
        
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
        
        // Check if we should suppress reading for debug console or other panels
        if (shouldSuppressReadingEnhanced(e.textEditor)) {
            return;
        }
        
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

    // Register undo command interceptor to play sound immediately
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.undoWithSound', async () => {
            log('[NavEditor] Undo command triggered - playing undo sound');
            
            // Play "Undo" sound immediately
            try {
                await speakTokenList([{
                    tokens: ['Undo'],
                    category: 'comment_text'
                }]);
            } catch (error) {
                log(`[NavEditor] Error playing undo sound: ${error}`);
            }
            
            // Execute the actual undo command
            await vscode.commands.executeCommand('undo');
            
            // Set undo operation flag to suppress subsequent TTS
            isUndoOperation = true;
            lastUndoTime = Date.now();
            
            // Clear any existing timeout
            if (undoDetectionTimeout) {
                clearTimeout(undoDetectionTimeout);
            }
            
            // Set timeout to resume normal TTS after undo window
            undoDetectionTimeout = setTimeout(() => {
                isUndoOperation = false;
                log('[NavEditor] Undo detection window expired - resuming normal TTS');
            }, UNDO_DETECTION_WINDOW_MS);
        })
    );

    // Register cleanup disposal
    context.subscriptions.push({
        dispose: cleanupNavEditor
    });


}
