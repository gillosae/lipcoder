import * as vscode from 'vscode';
import * as path from 'path';
import { config, earconModeState, EarconMode } from '../config';
import { LineSeverityMap } from './line_severity';
import { playWave, playEarcon, speakTokenList, TokenChunk, audioPlayer } from '../audio';
import { stopAllAudio } from './stop_reading';
import { isEarcon, getSpecialCharSpoken } from '../mapping';
import { findTokenSound } from '../earcon';
import { log } from '../utils';
import { shouldSuppressReadingEnhanced } from './debug_console_detection';

// Track when readTextTokens is actively processing to prevent navigation audio conflicts
let isReadTextTokensActive = false;

// Abort controller to preempt any in-flight typing TTS on new keystrokes
let typingAbortController: AbortController | null = null;

// Micro-batching for rapid typing: coalesce chars and play as one sequence
type BatchState = { files: string[]; timer: NodeJS.Timeout | null };
const charBatchByUri = new Map<string, BatchState>();
const BATCH_IDLE_MS = 35; // flush after brief idle
const MAX_BATCH_SIZE = 3; // flush when sustained typing hits this many chars

function resolveCharToFilePath(ch: string, audioMap: Record<string, string>): string | null {
    // Alphabet
    if (/^[a-zA-Z]$/.test(ch)) {
        const tokenPath = audioMap[ch.toLowerCase()];
        if (tokenPath) {
            return path.join(config.alphabetPath(), tokenPath);
        }
        return null;
    }
    // Numbers/specials via earcon mapping
    const resolved = findTokenSound(ch);
    if (resolved) return resolved;
    // Fallback to audioMap earcon if present
    if (audioMap[ch]) {
        return path.join(config.audioPath(), 'earcon', audioMap[ch]);
    }
    return null;
}

function enqueueCharPlayback(uri: string, ch: string, audioMap: Record<string, string>): void {
    const filePath = resolveCharToFilePath(ch, audioMap);
    if (!filePath) return;
    let state = charBatchByUri.get(uri);
    if (!state) {
        state = { files: [], timer: null };
        charBatchByUri.set(uri, state);
    }
    state.files.push(filePath);
    // Size-based flush to ensure playback during sustained typing
    if (state.files.length >= MAX_BATCH_SIZE) {
        // Do not kill current playback here; rely on ordered queue to preserve sequence
        const filesNow = state.files.slice();
        state.files = [];
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        audioPlayer.playSequence(filesNow, { rate: config.playSpeed, immediate: true }).catch(() => {});
        return;
    }
    if (state.timer) {
        clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
        // Preserve ordering: don't force-stop here; enqueue the batch
        const files = state!.files.slice();
        state!.files = [];
        state!.timer = null;
        // Apply global playspeed when flushing idle batch (pitch preserved internally)
        audioPlayer.playSequence(files, { rate: config.playSpeed, immediate: true }).catch(() => {});
    }, BATCH_IDLE_MS);
}

// Expose a way to clear any pending typing batches and abort in-flight typing TTS
export function clearTypingAudioStateForUri(uri?: string): void {
    try {
        if (typingAbortController) {
            typingAbortController.abort();
            typingAbortController = null;
        }
    } catch {}
    if (uri) {
        const state = charBatchByUri.get(uri);
        if (state) {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = null;
            }
            state.files = [];
        }
    } else {
        for (const [, state] of charBatchByUri) {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = null;
            }
            state.files = [];
        }
        charBatchByUri.clear();
    }
}

export function getReadTextTokensActive(): boolean {
    return isReadTextTokensActive;
}

// Helper function to calculate panning based on column position
function calculatePanning(column: number): number {
    if (!config.globalPanningEnabled) {
        return 0; // No panning if disabled
    }
    
    // Gentle panning: Map column 0-120 to panning -1.0 to +1.0
    // This prevents audio artifacts from extreme panning
    const maxColumn = 120;
    const clamped = Math.min(Math.max(column, 0), maxColumn);
    const normalized = clamped / maxColumn;

    const pan = (normalized * 2) - 1;

    return Math.max(-1, Math.min(1, pan));
}

export async function readTextTokens(
	event: vscode.TextDocumentChangeEvent,
	diagCache: Map<string, LineSeverityMap>,
	changes: readonly vscode.TextDocumentContentChangeEvent[],
	indentLevels: Map<string, number>,
	tabSize: number,
	skipNextIndentObj: { value: boolean },
	MAX_INDENT_UNITS: number,
	audioMap: Record<string, string>,
): Promise<void> {
    // Set flag to indicate readTextTokens is actively processing
    isReadTextTokensActive = true;
    
    try {
	log(`[readTextTokens] CALLED with changes: ${changes.map(c => `"${c.text}"`).join(', ')}`);
	log(`[readTextTokens] AudioMap received - "a": ${audioMap['a']}, "b": ${audioMap['b']}, keys: ${Object.keys(audioMap).length}`);
    
    // Check if we should suppress reading for debug console or other panels
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && shouldSuppressReadingEnhanced(activeEditor)) {
        log(`[readTextTokens] Suppressing reading for debug console or other panel`);
        return;
    }
    
    for (const change of changes) {
        // If Korean TTS is active from a previous operation, force-clear it for typing preemption
        const koreanTTSActive = (global as any).koreanTTSActive || false;
        if (koreanTTSActive) {
            (global as any).koreanTTSActive = false;
            log(`[readTextTokens] Cleared koreanTTSActive for typing preemption`);
        }

        // Cancel any in-flight typing TTS and stop audio immediately
        try {
            if (typingAbortController) {
                typingAbortController.abort();
            }
        } catch {}
        typingAbortController = new AbortController();
        log(`change.text:' ${JSON.stringify(change.text)}, rangeLength: ${change.rangeLength}, startChar: ${change.range.start.character}`);

        const uri = event.document.uri.toString();
        
        // Calculate panning based on column position
        const panning = calculatePanning(change.range.start.character);

        // ── 1) ENTER FIRST: if *any* change is a newline, play it and bail ─────────
        // Detect Enter even when auto-indent is inserted (e.g., '\n    ')
        if (changes.some(c => c.text.startsWith('\n'))) {
            log(`[readTextTokens] ENTER detected! Changes: ${changes.map(c => JSON.stringify(c.text)).join(', ')}`);
            stopAllAudio();

            // pick the right enter sound
            const newlineChange = changes.find(c => c.text.startsWith('\n'))!;
            const enterLine = newlineChange.range.start.line;
            const sevMap = diagCache.get(uri) || {};
            const sev = sevMap[enterLine] ?? vscode.DiagnosticSeverity.Hint;
            
            // DEBUG: Log diagnostic information
            log(`[readTextTokens] ENTER EARCON DEBUG:`);
            log(`[readTextTokens] - URI: ${uri}`);
            log(`[readTextTokens] - Enter line: ${enterLine}`);
            log(`[readTextTokens] - Diagnostic cache has ${Object.keys(sevMap).length} entries`);
            log(`[readTextTokens] - Severity for line ${enterLine}: ${sev} (${vscode.DiagnosticSeverity[sev]})`);
            log(`[readTextTokens] - All diagnostics for this file: ${JSON.stringify(sevMap)}`);
            
            const fileMap = {
                [vscode.DiagnosticSeverity.Error]: 'enter2.pcm',
                [vscode.DiagnosticSeverity.Warning]: 'enter2.pcm',
                [vscode.DiagnosticSeverity.Information]: 'enter2.pcm',
                [vscode.DiagnosticSeverity.Hint]: 'enter.pcm',
            } as const;
            const enterFile = path.join(config.audioPath(), 'earcon', fileMap[sev]);
            log(`[readTextTokens] Selected earcon file: ${enterFile}`);
            log(`[readTextTokens] File exists: ${require('fs').existsSync(enterFile)}`);
            
            // Use playWave directly with the diagnostic-based file selection
            // This ensures we play enter.pcm for normal lines and enter2.pcm for syntax errors
            playWave(enterFile, { isEarcon: true, immediate: true, panning }).then(() => {
                log(`[readTextTokens] Enter earcon playback completed successfully`);
            }).catch(err => {
                log(`[readTextTokens] Enter earcon playback failed: ${err}`);
            });

            // reset indent state so the following auto-indent spaces look fresh
            indentLevels.set(uri, 0);
            skipNextIndentObj.value = true;
            return;   // <<< bail out before indent logic
        }

        // ── 2) Handle indent for Tab, Backspace, and auto-indents ─────────────────
        // Earcon mapping:
        // - indent_0 to indent_4: Increasing indentation (based on current level)
        // - indent_5 to indent_9: Decreasing indentation (current level + 5)
        const oldRaw = indentLevels.get(uri) ?? 0;
        const lineNum = changes[0].range.start.line;
        const lineText = event.document.lineAt(lineNum).text;
        const leading = (lineText.match(/^\s*/)?.[0] || '');
        const rawUnits = Math.floor(leading.length / tabSize);

        if (skipNextIndentObj.value) {
            skipNextIndentObj.value = false;
            indentLevels.set(uri, rawUnits);
        } else {
            // Calculate indentation change direction and amount
            const indentChange = rawUnits - oldRaw;
            
            // Only play earcon if indentation actually changed
            if (indentChange !== 0) {
                if (indentChange > 0) {
                    // Indentation increased: use indent_0 to indent_4 (current level)
                    const idx = Math.min(rawUnits, 4);
                    // For indent earcons, we still need to use playWave since they use numbered files
                    // But we can use the earcon mode logic by checking if we should use TTS
                    if (earconModeState.mode === EarconMode.Text) {
                        playEarcon('indent_increase', panning);
                    } else {
                        playWave(path.join(config.audioPath(), 'earcon', `indent_${idx}.pcm`), { 
                            isEarcon: true, 
                            immediate: true
                        });
                    }
                    log(`[IndentEarcon] Increased indentation: ${oldRaw} → ${rawUnits} (change: +${indentChange}), playing indent_${idx}.pcm`);
                } else {
                    // Indentation decreased: use indent_5 to indent_9 (current level + 5)
                    const idx = Math.max(5, 9 - rawUnits);
                    // For indent earcons, we still need to use playWave since they use numbered files
                    // But we can use the earcon mode logic by checking if we should use TTS
                    if (earconModeState.mode === EarconMode.Text) {
                        playEarcon('indent_decrease', panning);
                    } else {
                        playWave(path.join(config.audioPath(), 'earcon', `indent_${idx}.pcm`), { 
                            isEarcon: true, 
                            immediate: true
                        });
                    }
                    log(`[IndentEarcon] Decreased indentation: ${oldRaw} → ${rawUnits} (change: ${indentChange}), playing indent_${idx}.pcm`);
                }
            }
            
            indentLevels.set(uri, rawUnits);
        }


        // ── 3) Handle plain backspace (single-char delete) FIRST ───────────────
        //    change.text==='' and exactly one character removed
        for (const change of changes) {
            if (change.text === '' && change.rangeLength === 1) {
                log(`[read_text_tokens] Backspace detected: rangeLength=${change.rangeLength}, text="${change.text}"`);
                stopAllAudio();
                // Only play backspace earcon if enabled in config
                if (config.backspaceEarconEnabled) {
                    log(`[read_text_tokens] Playing backspace earcon`);
                    playEarcon('backspace', panning);
                } else {
                    log(`[read_text_tokens] Backspace earcon disabled in config`);
                }
                return; // Exit early to prevent further processing
            }
        }

        // 4) Handle multi-character and single-character logic
        const text = change.text;
        if (text.length > 1) {
            // Break grouped input into individual tokens
            // OPTIMIZATION: Check if this is all alphabet characters for faster stopping
            const isAllAlphabet = /^[a-zA-Z]+$/.test(text);
            
            // Micro-batch: enqueue characters and flush after brief idle
            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                enqueueCharPlayback(uri, ch, audioMap);
            }
            continue;
        }
        // Single-character logic
        const char = text;
        // Prefer batching for single characters; avoid global stops on every key
        try {
            const specialCharSpoken = getSpecialCharSpoken(char);
            const isEarconChar = isEarcon(char);
            log(`[read_text_tokens] Processing single char: "${char}", audioMap[char]: ${audioMap[char]}, specialCharMap: ${specialCharSpoken}, isEarcon: ${isEarconChar}`);
            if (/^[a-zA-Z]$/.test(char) || (audioMap[char] && !/^[a-zA-Z]$/.test(char))) {
                enqueueCharPlayback(uri, char, audioMap);
                return;
            } else if (isEarcon(char)) {
                // Handle earcon characters (brackets, parentheses, etc.)
                log(`[read_text_tokens] 🔊 EARCON PATH: Playing earcon for "${char}" with panning ${panning}`);
                await playEarcon(char, panning);
                log(`[read_text_tokens] ✅ EARCON COMPLETED: Finished playing earcon for "${char}"`);
                return; // Prevent further processing to avoid double audio
            } else if (getSpecialCharSpoken(char)) {
                // Avoid heavy TTS during fast typing; try to resolve to earcon path via enqueue
                enqueueCharPlayback(uri, char, audioMap);
                return; // Prevent further processing to avoid double audio
            } else {
                // No audio found for character
            }
        } catch (err) {
            console.error('Typing audio error:', err);
        }
    }
    
    } finally {
        // Clear flag when readTextTokens processing is complete
        isReadTextTokensActive = false;
    }
}