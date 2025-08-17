import * as vscode from 'vscode';
import * as path from 'path';
import { config } from '../config';
import { LineSeverityMap } from './line_severity';
import { playWave, playEarcon, speakTokenList, TokenChunk } from '../audio';
import { stopAllAudio } from './stop_reading';
import { isEarcon, specialCharMap } from '../mapping';
import { log } from '../utils';

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
    skipNextIndent: boolean,
    MAX_INDENT_UNITS: number,
    audioMap: Record<string, string>,
): Promise<void> {
    for (const change of changes) {
        // Immediately halt any currently playing audio when a new key event occurs
        stopAllAudio();
        log(`change.text:' ${JSON.stringify(change.text)}, rangeLength: ${change.rangeLength}, startChar: ${change.range.start.character}`);

        const uri = event.document.uri.toString();
        
        // Calculate panning based on column position
        const panning = calculatePanning(change.range.start.character);

        // ── 1) ENTER FIRST: if *any* change is a newline, play it and bail ─────────
        // Detect Enter even when auto-indent is inserted (e.g., '\n    ')
        if (changes.some(c => c.text.startsWith('\n'))) {
            stopAllAudio();

            // pick the right enter sound
            const newlineChange = changes.find(c => c.text.startsWith('\n'))!;
            const enterLine = newlineChange.range.start.line;
            const sevMap = diagCache.get(uri) || {};
            const sev = sevMap[enterLine] ?? vscode.DiagnosticSeverity.Hint;
            const fileMap = {
                [vscode.DiagnosticSeverity.Error]: 'enter2.pcm',
                [vscode.DiagnosticSeverity.Warning]: 'enter2.pcm',
                [vscode.DiagnosticSeverity.Information]: 'enter2.pcm',
                [vscode.DiagnosticSeverity.Hint]: 'enter.pcm',
            } as const;
            const enterFile = path.join(config.audioPath(), 'earcon', fileMap[sev]);
            playWave(enterFile, { isEarcon: true, immediate: true });

            // reset indent state so the following auto-indent spaces look fresh
            indentLevels.set(uri, 0);
            skipNextIndent = true;
            return;   // <<< bail out before indent logic
        }

        // ── 2) Handle indent for Tab, Backspace, and auto-indents ─────────────────
        const oldRaw = indentLevels.get(uri) ?? 0;
        const lineNum = changes[0].range.start.line;
        const lineText = event.document.lineAt(lineNum).text;
        const leading = (lineText.match(/^\s*/)?.[0] || '');
        const rawUnits = Math.floor(leading.length / tabSize);

        if (skipNextIndent) {
            skipNextIndent = false;
            indentLevels.set(uri, rawUnits);
        } else {
            const isBackspace = changes.some(c => c.text === '' && c.rangeLength === 1);
            // detect Tab key when VSCode inserts literal '\t' or spaces equal to tabSize
            const isTab = changes.some(c =>
                c.text === '\t'
                || (tabSize > 0 && c.text === ' '.repeat(tabSize))
            );

            if (isTab) {
                // Manual Tab: indent_0 → indent_4
                const idx = rawUnits > 4 ? 4 : rawUnits;
                playWave(path.join(config.audioPath(), 'earcon', `indent_${idx}.pcm`), { isEarcon: true, immediate: true });
                indentLevels.set(uri, rawUnits);

            } else if (isBackspace) {
                // Manual Backspace: indent_5 → indent_9
                const idx = rawUnits + 5 > 9 ? 9 : rawUnits + 5;
                playWave(path.join(config.audioPath(), 'earcon', `indent_${idx}.pcm`), { isEarcon: true, immediate: true });
                indentLevels.set(uri, rawUnits);

            } else {
                // Auto-indent: same as before
                if (rawUnits > oldRaw) {
                    const idx = rawUnits > MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : rawUnits - 1;
                    playWave(path.join(config.audioPath(), 'earcon', `indent_${idx}.pcm`), { isEarcon: true, immediate: true });
                } else if (rawUnits < oldRaw) {
                    const idx = rawUnits > MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : rawUnits;
                    playWave(path.join(config.audioPath(), 'earcon', `indent_${idx}.pcm`), { isEarcon: true, immediate: true });
                }
                indentLevels.set(uri, rawUnits);
            }
        }


        // ── 3) Finally, handle plain backspace (single-char delete) ───────────────
        //    change.text==='' and exactly one character removed
        for (const change of changes) {
            if (change.text === '' && change.rangeLength === 1) {
                stopAllAudio();
                playWave(path.join(config.audioPath(), 'earcon', 'backspace.pcm'), { isEarcon: true, immediate: true });
                break;
            }
        }

        // 4) Handle multi-character and single-character logic
        const text = change.text;
        if (text.length > 1) {
            // Break grouped input into individual tokens
            // Stop audio once at the beginning of the sequence, not per character
            stopAllAudio();
            
            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                // Calculate panning for each character based on its position
                const charPanning = calculatePanning(change.range.start.character + i);
                
                // Remove redundant stopAllAudio() call here
                try {
                    if (audioMap[ch]) {
                        playWave(audioMap[ch], { isEarcon: true, immediate: true, panning: charPanning });
                    } else if (specialCharMap[ch]) {
                        // Remove redundant stopAllAudio() call here
                        if (isEarcon(ch)) {
                            await playEarcon(ch, charPanning);
                        } else {
                            await speakTokenList([{ tokens: [specialCharMap[ch]], category: 'special', panning: charPanning }]);
                        }
                    } else if (/^[a-zA-Z]$/.test(ch)) {
                        const tokenPath = audioMap[ch.toLowerCase()];
                        if (tokenPath) playWave(tokenPath, { immediate: true, panning: charPanning });
                    } else {
                        console.log('🚫 No audio found for grouped char:', ch);
                    }
                } catch (err) {
                    console.error('Typing audio error:', err);
                }
            }
            continue;
        }
        // Single-character logic
        const char = text;
        stopAllAudio();
        try {
            console.log(`[read_text_tokens] Processing char: "${char}", audioMap: ${audioMap[char]}, specialCharMap: ${specialCharMap[char]}, isEarcon: ${isEarcon(char)}`);
            if (audioMap[char]) {
                console.log(`[read_text_tokens] Using audioMap path for "${char}": ${audioMap[char]}`);
                playWave(audioMap[char], { isEarcon: true, immediate: true, panning });
                return; // Prevent further processing to avoid double audio
            } else if (specialCharMap[char]) {
                console.log(`[read_text_tokens] Using specialCharMap path for "${char}"`);
                // Remove redundant stopAllAudio() call here
                if (isEarcon(char)) {
                    await playEarcon(char, panning);
                } else {
                    await speakTokenList([{ tokens: [specialCharMap[char]], category: 'special', panning }]);
                }
                return; // Prevent further processing to avoid double audio
            } else if (/^[a-zA-Z]$/.test(char)) {
                const tokenPath = audioMap[char.toLowerCase()];
                if (tokenPath) {
                    playWave(tokenPath, { immediate: true, panning });
                    return; // Prevent further processing to avoid double audio
                }
            } else {
                console.log('🚫 No audio found for char:', char);
            }
        } catch (err) {
            console.error('Typing audio error:', err);
        }
    }

}