import * as vscode from 'vscode';
import * as path from 'path';
import { config } from '../config';
import { LineSeverityMap } from './line_severity';
import { playSpecial, playWave, stopPlayback } from '../audio';
import { specialCharMap } from '../mapping';
import { log } from '../utils';


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
        stopPlayback();
        log(`change.text:' ${JSON.stringify(change.text)}, rangeLength: ${change.rangeLength}, startChar: ${change.range.start.character}`);

        const uri = event.document.uri.toString();

        // ── 1) ENTER FIRST: if *any* change is a newline, play it and bail ─────────
        // Detect Enter even when auto-indent is inserted (e.g., '\n    ')
        if (changes.some(c => c.text.startsWith('\n'))) {
            stopPlayback();

            // pick the right enter sound
            const newlineChange = changes.find(c => c.text.startsWith('\n'))!;
            const enterLine = newlineChange.range.start.line;
            const sevMap = diagCache.get(uri) || {};
            const sev = sevMap[enterLine] ?? vscode.DiagnosticSeverity.Hint;
            const fileMap = {
                [vscode.DiagnosticSeverity.Error]: 'enter2.wav',
                [vscode.DiagnosticSeverity.Warning]: 'enter2.wav',
                [vscode.DiagnosticSeverity.Information]: 'enter2.wav',
                [vscode.DiagnosticSeverity.Hint]: 'enter.wav',
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
                playWave(path.join(config.audioPath(), 'earcon', `indent_${idx}.wav`), { isEarcon: true, immediate: true });
                indentLevels.set(uri, rawUnits);

            } else if (isBackspace) {
                // Manual Backspace: indent_5 → indent_9
                const idx = rawUnits + 5 > 9 ? 9 : rawUnits + 5;
                playWave(path.join(config.audioPath(), 'earcon', `indent_${idx}.wav`), { isEarcon: true, immediate: true });
                indentLevels.set(uri, rawUnits);

            } else {
                // Auto-indent: same as before
                if (rawUnits > oldRaw) {
                    const idx = rawUnits > MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : rawUnits - 1;
                    playWave(path.join(config.audioPath(), 'earcon', `indent_${idx}.wav`), { isEarcon: true, immediate: true });
                } else if (rawUnits < oldRaw) {
                    const idx = rawUnits > MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : rawUnits;
                    playWave(path.join(config.audioPath(), 'earcon', `indent_${idx}.wav`), { isEarcon: true, immediate: true });
                }
                indentLevels.set(uri, rawUnits);
            }
        }


        // ── 3) Finally, handle plain backspace (single-char delete) ───────────────
        //    change.text==='' and exactly one character removed
        for (const change of changes) {
            if (change.text === '' && change.rangeLength === 1) {
                stopPlayback();
                playWave(path.join(config.audioPath(), 'earcon', 'backspace.wav'), { isEarcon: true, immediate: true });
                break;
            }
        }

        // 4) Handle multi-character and single-character logic
        const text = change.text;
        if (text.length > 1) {
            // Break grouped input into individual tokens
            for (const ch of text) {
                stopPlayback();
                try {
                    if (audioMap[ch]) {
                        playWave(audioMap[ch], { isEarcon: true, immediate: true });
                    } else if (specialCharMap[ch]) {
                        stopPlayback();
                        playSpecial(specialCharMap[ch]);
                    } else if (/^[a-zA-Z]$/.test(ch)) {
                        const tokenPath = audioMap[ch.toLowerCase()];
                        if (tokenPath) playWave(tokenPath, { immediate: true });
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
        stopPlayback();
        try {
            if (audioMap[char]) {
                playWave(audioMap[char], { isEarcon: true, immediate: true });
            } else if (specialCharMap[char]) {
                stopPlayback();
                playSpecial(specialCharMap[char]);
            } else if (/^[a-zA-Z]$/.test(char)) {
                const tokenPath = audioMap[char.toLowerCase()];
                if (tokenPath) playWave(tokenPath, { immediate: true });
            } else {
                console.log('🚫 No audio found for char:', char);
            }
        } catch (err) {
            console.error('Typing audio error:', err);
        }
    }

}