import * as vscode from 'vscode';
import { speakTokenList } from '../audio';
import { stopAllAudio } from './stop_reading';
import { log } from '../utils';
import { config } from '../config';

const bufferMap = new Map<string, string>();

// Helper function to calculate panning based on column position
function calculatePanning(column: number): number {
    if (!config.globalPanningEnabled) {
        return 0; // No panning if disabled
    }
    
    // Map column 0-120 to panning -1.0 to +1.0
    // Columns beyond 120 will be clamped to +1.0
    const maxColumn = 120;
    const normalizedColumn = Math.min(column, maxColumn) / maxColumn;
    return (normalizedColumn * 2) - 1; // Convert 0-1 to -1 to +1
}

export async function readWordTokens(
    event: vscode.TextDocumentChangeEvent,
    changes: readonly vscode.TextDocumentContentChangeEvent[],
) {
    const uri = event.document.uri.toString();
    let buf = bufferMap.get(uri) || '';

    for (const change of changes) {
        const text = change.text;
        // Calculate panning based on column position
        const panning = calculatePanning(change.range.start.character);
        
        // if user types a space (or newline), speak accumulated buffer + the space
        if (text === ' ' || text === '\n' || text === '\t') {
            // halt any ongoing audio
            stopAllAudio();

            const word = buf.trim();
            if (word) {
                log(`[readWordTokens] speaking word="${word}"`);
                // Send as variable category so universal word logic in speakTokenList applies
                const category = /^\d+$/.test(word) ? 'literal' : 'variable';
                await speakTokenList([{ tokens: [word], category, panning }]);
            }
            // optionally speak the space itself as an earcon or omit
            bufferMap.set(uri, '');
        } else {
            // accumulate characters that are part of the current word
            buf += text;
            bufferMap.set(uri, buf);
        }
    }
}