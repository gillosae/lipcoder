import * as vscode from 'vscode';
import { log } from '../utils';
import { isFileTreeReading } from './file_tree';
import { stopReading, getLineTokenReadingActive, stopForCursorMovement, stopAllAudio, lineAbortController, setLineTokenReadingActive, bumpNavigationGeneration, getNavigationGeneration } from './stop_reading';
import { speakTokenList, TokenChunk, readCurrentLine, readCurrentWord, readWordNearCursor } from '../audio';
import { readWordTokens } from './read_word_tokens';
import { readTextTokens, getReadTextTokensActive, clearTypingAudioStateForUri } from './read_text_tokens';
import { config } from '../config';
import { updateLineSeverity } from './line_severity';
import { shouldSuppressReadingEnhanced } from './debug_console_detection';
// Audio Minimap removed - imports commented out
// import { shouldUseAudioMinimap, updateContinuousTone, resetSpeedTracking, cleanupAudioMinimap, isContinuousTonePlaying } from './audio_minimap';

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
    // Audio Minimap removed - cleanup calls commented out
    // resetSpeedTracking(); // Reset audio minimap tracking
    // cleanupAudioMinimap();     // Cleanup continuous tone generator
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
    
    // Initialize indentation level for current document
    if (editor) {
        const currentPosition = editor.selection.active;
        const currentLine = editor.document.lineAt(currentPosition.line);
        const currentIndentLevel = Math.floor((currentLine.text.length - currentLine.text.trimStart().length) / tabSize);
        indentLevels.set(editor.document.uri.toString(), currentIndentLevel);
        log(`[NavEditor] Initialized indent level for ${editor.document.fileName}: ${currentIndentLevel}`);
    }

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
            // resetSpeedTracking(); // Audio Minimap removed
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
                // resetSpeedTracking(); // Audio Minimap removed
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
                    editor,
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
                
                // ALWAYS stop any ongoing audio on line change, even if typing-related
                // This prevents the previous line from continuing to play after moving the cursor
                log('[NavEditor] CURSOR LINE CHANGE - enforcing immediate audio stop');
                // Bump navigation generation to invalidate any in-flight reads
                const gen = bumpNavigationGeneration();
                log(`[NavEditor] Bumped navigation generation to ${gen}`);

                // 1. Cancel any pending line read from previous cursor movement
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

                // 4. Clear any pending typing batches for this document
                try {
                    clearTypingAudioStateForUri(e.textEditor.document.uri.toString());
                    log('[NavEditor] Cleared typing audio batch state for current document');
                } catch {}

                // 5. Stop ALL previous audio immediately before starting new line reading
                stopForCursorMovement(); // Use comprehensive TTS stop for cursor movement
                log('[NavEditor] Stopped ALL TTS (including male/female voices) before new line reading');

                // 6. Do NOT abort here. stopAllAudio() already aborted and replaced the controller.

                // 7. Additional safety: Clear any audio player state
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

                // Update current line BEFORE reading to ensure correct line is read
                currentLineNum = lineNum;
                currentCursor = e.selections[0].active;
                lastCursorMoveTime = Date.now();
                log(`[cursor-log] Updated to line=${lineNum}, column=${currentCursor.character}, typing-related=${isTypingRelated}`);
                
                // Clear any existing idle timeout
                if (cursorIdleTimeout) {
                    clearTimeout(cursorIdleTimeout);
                    cursorIdleTimeout = null;
                }
                
                // Always use line reading for cursor movement (Audio Minimap removed)
                if (!isTypingRelated && config.cursorLineReadingEnabled) {
                    log(`[NavEditor] 🎯 Checking line reading conditions: !isTypingRelated=${!isTypingRelated}, cursorLineReadingEnabled=${config.cursorLineReadingEnabled}`);
                    
                    // Check if automatic reading is suppressed (e.g., during vibe coding)
                    if (suppressAutomaticReading) {
                        log('[NavEditor] ❌ BLOCKED - suppressAutomaticReading is true');
                        return;
                    }
                    
                    // Audio Minimap removed - always do line reading
                    log(`[NavEditor] 🔊 Audio Minimap disabled - proceeding with line reading`);
                    
                    // Always proceed with line reading since Audio Minimap is disabled
                    {
                        // Longer delay to ensure ALL previous TTS processes are completely terminated
                        log(`[NavEditor] 🚀 STARTING line reading for line ${lineNum} (with 100ms delay for complete TTS termination)`);
                        log(`[NavEditor] Editor info: scheme=${e.textEditor.document.uri.scheme}, path=${e.textEditor.document.uri.path}`);
                        
                        // Capture the current editor state to avoid race conditions
                        const capturedEditor = e.textEditor;
                        const capturedLineNumber = e.selections[0].active.line; // 0-based line number
                        
                        // Cancel any previously scheduled line read
                        if (pendingLineReadTimeout) {
                            clearTimeout(pendingLineReadTimeout);
                            pendingLineReadTimeout = null;
                            log('[NavEditor] Cancelled previous pending line read (keyboard)');
                        }

                        const scheduledLineNumber = capturedLineNumber;
                        const scheduledGen = getNavigationGeneration();
                        pendingLineReadTimeout = setTimeout(async () => {
                            try {
                                // Guard by navigation generation and line number
                                if (scheduledGen !== getNavigationGeneration()) {
                                    log(`[NavEditor] ⏭️ Skipping stale line read by generation. scheduledGen=${scheduledGen}, currentGen=${getNavigationGeneration()}`);
                                    return;
                                }
                                // Guard: skip if cursor has moved to a different line since scheduling
                                if (scheduledLineNumber !== currentLineNum) {
                                    log(`[NavEditor] ⏭️ Skipping stale line read. Scheduled=${scheduledLineNumber + 1}, current=${currentLineNum + 1}`);
                                    return;
                                }

                                log(`[NavEditor] Reading captured line: ${scheduledLineNumber + 1} (0-based: ${scheduledLineNumber})`);
                                
                                // Call readCurrentLine directly with specific line number
                                await readCurrentLine(capturedEditor, scheduledLineNumber);
                                
                                log(`[NavEditor] ✅ readCurrentLine completed for line ${lineNum}`);
                            } catch (err) {
                                console.error(`[NavEditor] ❌ readCurrentLine failed for line ${lineNum}:`, err);
                                log(`[NavEditor] ❌ readCurrentLine failed for line ${lineNum}: ${err}`);
                            } finally {
                                // Clear the pending handle if this callback ran
                                pendingLineReadTimeout = null;
                            }
                        }, 50); // Reduced delay to 50ms to minimize race conditions
                    }
                } else {
                    // Typing-related movement: do NOT start a new read, but we already stopped previous audio above
                    log(`[NavEditor] ⏭️ Skipping new line read due to typing-related movement (stopped previous audio). isTypingRelated=${isTypingRelated}, cursorLineReadingEnabled=${config.cursorLineReadingEnabled}`);
                }
            } catch (err: any) {
                console.error('onDidChangeTextEditorSelection handler error:', err);
            }
        }),
        // Reset speed tracking when changing editors (Audio Minimap removed)
        vscode.window.onDidChangeActiveTextEditor((newEditor) => {
            // resetSpeedTracking(); // Audio Minimap removed
            
            // Initialize indentation level for new editor
            if (newEditor) {
                const currentPosition = newEditor.selection.active;
                const currentLine = newEditor.document.lineAt(currentPosition.line);
                const newTabSize = newEditor.options && typeof newEditor.options.tabSize === 'number' ? newEditor.options.tabSize : 4;
                const currentIndentLevel = Math.floor((currentLine.text.length - currentLine.text.trimStart().length) / newTabSize);
                indentLevels.set(newEditor.document.uri.toString(), currentIndentLevel);
                log(`[NavEditor] Initialized indent level for new editor ${newEditor.document.fileName}: ${currentIndentLevel}`);
            }
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
                
                // Don't stop reading after line reading completes - this interferes with TTS
                // The line reading has completed successfully, no need to stop anything
                log('[NavEditor] Line reading completed - not calling stopReading to avoid TTS interference');
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
            const movedSameLine = old && sel.line === old.line;
            const movedByOneChar = movedSameLine && Math.abs(sel.character - old.character) === 1;

            if (movedByOneChar) {
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
                        // stopForCursorMovement(); // Removed to prevent TTS interruption
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

            // Handle word-wise navigation: same line, jump by >1 character (Option+Left/Right)
            if (movedSameLine && Math.abs(sel.character - old.character) > 1) {
                // Honor user preference
                if (config.cursorWordReadingEnabled) {
                    // Avoid double-trigger near typing
                    const timeSinceTyping = Date.now() - lastTypingTime;
                    const isTypingRelated = timeSinceTyping < TYPING_DETECTION_WINDOW_MS;
                    if (!isTypingRelated) {
                        try {
                            const direction = sel.character > old.character ? 'right' : 'left';
                            readWordNearCursor(direction);
                        } catch {}
                    }
                }
                currentCursor = sel;
                return;
            }

            if (sel.line === currentLineNum) {
                currentCursor = sel;
                return;
            }

            // For line changes: only this handler processes MOUSE events.
            // Keyboard line changes are handled by the primary handler above to avoid double triggers.
            if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
                log('[NavEditor] Skipping line-change handling here for keyboard; primary handler manages it');
                currentLineNum = sel.line;
                currentCursor = sel;
                return;
            }

            // ULTRA-AGGRESSIVE STOP for line change on MOUSE selection
            try {
                const timeSinceTyping = Date.now() - lastTypingTime;
                const isTypingRelated = timeSinceTyping < TYPING_DETECTION_WINDOW_MS;
                log(`[NavEditor] (Mouse) Line change detected → aggressive stop. typingRelated=${isTypingRelated}`);

                if (pendingLineReadTimeout) {
                    clearTimeout(pendingLineReadTimeout);
                    pendingLineReadTimeout = null;
                    log('[NavEditor] Cancelled pending line read timeout (mouse/keyboard)');
                }

                (global as any).koreanTTSActive = false;
                setLineTokenReadingActive(false);

                // Ensure all previous TTS/earcon processes are killed before scheduling new read
                stopForCursorMovement();
                log('[NavEditor] (Mouse) Stopped ALL TTS before scheduling new line read');

                // Don't stop audio here - let high priority TTS handle interruption
                // stopForCursorMovement(); // Removed to prevent TTS interruption
                // Note: High priority TTS will automatically interrupt previous speech

                // Do NOT abort here. stopAllAudio() already aborted and replaced the controller.

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
            // Bump navigation generation for mouse line-change as well
            const gen = bumpNavigationGeneration();
            log(`[NavEditor] (Mouse) Bumped navigation generation to ${gen}`);
            // Cancel any previously scheduled line read
            if (pendingLineReadTimeout) {
                clearTimeout(pendingLineReadTimeout);
                pendingLineReadTimeout = null;
                log('[NavEditor] Cancelled previous pending line read (mouse)');
            }

            const capturedEditor = e.textEditor;
            const scheduledLineNumber = sel.line;
            const scheduledGen = getNavigationGeneration();
            pendingLineReadTimeout = setTimeout(async () => {
                try {
                    if (scheduledGen !== getNavigationGeneration()) {
                        log(`[NavEditor] ⏭️ Skipping stale line read (mouse) by generation. scheduledGen=${scheduledGen}, currentGen=${getNavigationGeneration()}`);
                        return;
                    }
                    if (scheduledLineNumber !== currentLineNum) {
                        log(`[NavEditor] ⏭️ Skipping stale line read (mouse). Scheduled=${scheduledLineNumber + 1}, current=${currentLineNum + 1}`);
                        return;
                    }
                    await readCurrentLine(capturedEditor, scheduledLineNumber);
                } finally {
                    pendingLineReadTimeout = null;
                }
            }, 50);
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
