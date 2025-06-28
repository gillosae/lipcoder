import * as vscode from 'vscode';
import { log } from '../utils';


export interface LineSeverityMap { [line: number]: vscode.DiagnosticSeverity }
const diagCache: Map<string /* uri */, LineSeverityMap> = new Map();

export function updateLineSeverity() {
    vscode.languages.onDidChangeDiagnostics(e => {
        for (const uri of e.uris) {
            const all = vscode.languages.getDiagnostics(uri)
                .filter(d => d.source === 'Pylance');
            const lineMap: LineSeverityMap = {};
            for (const d of all) {
                const ln = d.range.start.line;
                // pick highest‐priority (Error < Warning < Info < Hint)
                lineMap[ln] = Math.min(
                    lineMap[ln] ?? vscode.DiagnosticSeverity.Hint,
                    d.severity
                );
            }
            diagCache.set(uri.toString(), lineMap);
        }
    });

    return diagCache;
}