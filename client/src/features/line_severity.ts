import * as vscode from 'vscode';
import { log } from '../utils';


export interface LineSeverityMap { [line: number]: vscode.DiagnosticSeverity }
const diagCache: Map<string /* uri */, LineSeverityMap> = new Map();

/**
 * Get the diagnostic cache
 */
export function getDiagnosticCache(): Map<string, LineSeverityMap> {
    return diagCache;
}

/**
 * Get line severity for a specific line in a document
 */
export function getLineSeverity(uri: string, line: number): vscode.DiagnosticSeverity | null {
    const lineMap = diagCache.get(uri);
    if (!lineMap || !(line in lineMap)) {
        return null;
    }
    return lineMap[line];
}

export function updateLineSeverity() {
    vscode.languages.onDidChangeDiagnostics(e => {
        for (const uri of e.uris) {
            const all = vscode.languages.getDiagnostics(uri)
                .filter(d => {
                    // Accept diagnostics from TypeScript, ESLint, and Pylance
                    return d.source === 'Pylance' || 
                           d.source === 'ts' || 
                           d.source === 'typescript' ||
                           d.source === 'eslint' ||
                           !d.source; // Include diagnostics without a source (often TypeScript)
                });
            const lineMap: LineSeverityMap = {};
            for (const d of all) {
                const ln = d.range.start.line;
                // pick highest‐priority (Error < Warning < Info < Hint)
                lineMap[ln] = Math.min(
                    lineMap[ln] ?? vscode.DiagnosticSeverity.Hint,
                    d.severity ?? vscode.DiagnosticSeverity.Hint
                );
            }
            diagCache.set(uri.toString(), lineMap);
            log(`[LineSeverity] Updated diagnostics for ${uri.toString()}: ${Object.keys(lineMap).length} lines with issues`);
        }
    });

    return diagCache;
}