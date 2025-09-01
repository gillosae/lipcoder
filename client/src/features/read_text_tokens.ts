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
        // Check if Korean TTS is active and should be protected
        const koreanTTSActive = (global as any).koreanTTSActive || false;
        if (koreanTTSActive) {
            log(`[readTextTokens] Korean TTS is active - skipping text reading to prevent interruption`);
            return;
        }
        
        // Immediately halt any currently playing audio when a new key event occurs
        stopAllAudio();
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
            
            if (isAllAlphabet) {
                // For all-alphabet input, use direct audioPlayer stopping for faster response
                audioPlayer.stopCurrentPlayback(true);
                log(`[read_text_tokens] MULTI-ALPHABET FAST STOP: Used direct audioPlayer stop for "${text}"`);
            } else {
                // For mixed content, use regular stopAllAudio()
                stopAllAudio();
            }
            
            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                // Calculate panning for each character based on its position
                const charPanning = calculatePanning(change.range.start.character + i);
                
                // Remove redundant stopAllAudio() call here
                try {
                    if (/^[a-zA-Z]$/.test(ch)) {
                        // Handle alphabet characters first with proper path construction
                        const tokenPath = audioMap[ch.toLowerCase()];
                        if (tokenPath) {
                            const fullPath = path.join(config.alphabetPath(), tokenPath);
                            audioPlayer.playPcmCached(fullPath, charPanning);
                        }
                    } else if (audioMap[ch] && !/^[a-zA-Z]$/.test(ch)) {
                        // Handle non-alphabet audioMap entries (numbers, special chars)
                        // Use proper path resolution that checks both special and earcon directories
                        const resolvedPath = findTokenSound(ch);
                        if (resolvedPath) {
                            playWave(resolvedPath, { 
                                isEarcon: true, 
                                immediate: true, 
                                panning: charPanning
                            });
                        } else {
                            // Fallback to earcon directory if findTokenSound doesn't find it
                            const fallbackPath = path.join(config.audioPath(), 'earcon', audioMap[ch]);
                            playWave(fallbackPath, { 
                                isEarcon: true, 
                                immediate: true, 
                                panning: charPanning
                            });
                        }
                    } else if (isEarcon(ch)) {
                        // Handle earcon characters (brackets, parentheses, etc.)
                        await playEarcon(ch, charPanning);
                    } else if (getSpecialCharSpoken(ch)) {
                        // Handle TTS for special characters
                        await speakTokenList([{ tokens: [getSpecialCharSpoken(ch)!], category: 'special', panning: charPanning }]);
                    } else {
                        // No audio found for grouped char
                    }
                } catch (err) {
                    console.error('Typing audio error:', err);
                }
            }
            continue;
        }
        // Single-character logic
        const char = text;
        
        // OPTIMIZATION: For alphabet characters, use direct audioPlayer stopping for faster response
        if (/^[a-zA-Z]$/.test(char)) {
            // For alphabet characters, use immediate audioPlayer stopping instead of stopAllAudio()
            audioPlayer.stopCurrentPlayback(true);
            log(`[read_text_tokens] ALPHABET FAST STOP: Used direct audioPlayer stop for "${char}"`);
        } else {
            // For non-alphabet characters, use regular stopAllAudio()
            stopAllAudio();
        }
        try {
            const specialCharSpoken = getSpecialCharSpoken(char);
            const isEarconChar = isEarcon(char);
            log(`[read_text_tokens] Processing single char: "${char}", audioMap[char]: ${audioMap[char]}, specialCharMap: ${specialCharSpoken}, isEarcon: ${isEarconChar}`);
            if (/^[a-zA-Z]$/.test(char)) {
                // Handle alphabet characters first with proper path construction
                const tokenPath = audioMap[char.toLowerCase()];
                log(`[read_text_tokens] Alphabet char "${char}" -> tokenPath: ${tokenPath}`);
                if (tokenPath) {
                    const fullPath = path.join(config.alphabetPath(), tokenPath);
                    log(`[read_text_tokens] Playing alphabet audio (cached) for "${char}": ${fullPath}`);
                    audioPlayer.playPcmCached(fullPath, panning);
                    return; // Prevent further processing to avoid double audio
                } else {
                    log(`[read_text_tokens] No tokenPath found for alphabet char "${char}"`);
                }
            } else if (audioMap[char] && !/^[a-zA-Z]$/.test(char)) {
                // Handle non-alphabet audioMap entries (numbers, special chars)
                // Use proper path resolution that checks both special and earcon directories
                const resolvedPath = findTokenSound(char);
                if (resolvedPath) {
                    log(`[read_text_tokens] 🔊 RESOLVED: Playing resolved audio for "${char}": ${resolvedPath}`);
                    playWave(resolvedPath, { 
                        isEarcon: true, 
                        immediate: true, 
                        panning
                    });
                } else {
                    // Fallback to earcon directory if findTokenSound doesn't find it
                    const fallbackPath = path.join(config.audioPath(), 'earcon', audioMap[char]);
                    log(`[read_text_tokens] 🔄 FALLBACK: Using fallback path for "${char}": ${fallbackPath}`);
                    playWave(fallbackPath, { 
                        isEarcon: true, 
                        immediate: true, 
                        panning
                    });
                }
                return; // Prevent further processing to avoid double audio
            } else if (isEarcon(char)) {
                // Handle earcon characters (brackets, parentheses, etc.)
                log(`[read_text_tokens] 🔊 EARCON PATH: Playing earcon for "${char}" with panning ${panning}`);
                await playEarcon(char, panning);
                log(`[read_text_tokens] ✅ EARCON COMPLETED: Finished playing earcon for "${char}"`);
                return; // Prevent further processing to avoid double audio
            } else if (getSpecialCharSpoken(char)) {
                // Handle TTS for special characters
                await speakTokenList([{ tokens: [getSpecialCharSpoken(char)!], category: 'special', panning }]);
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