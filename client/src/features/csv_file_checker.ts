import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionContext } from 'vscode';
import { speakTokenList, TokenChunk } from '../audio';
import { log, logError, logSuccess } from '../utils';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface CSVFileInfo {
    path: string;
    name: string;
    size: number;
    lines?: number;
    headers?: string[];
}

/**
 * Execute bash script to find CSV files in the codebase
 */
export async function checkCSVFilesWithBash(): Promise<CSVFileInfo[]> {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('No workspace folder open');
        }
        
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        log(`[CSV Checker] Searching for CSV files in: ${workspaceRoot}`);
        
        // Create bash command to find CSV files
        const bashCommand = `
            cd "${workspaceRoot}" && 
            find . -name "*.csv" -type f 2>/dev/null | 
            while read -r file; do
                if [ -f "$file" ]; then
                    size=$(wc -c < "$file" 2>/dev/null || echo "0")
                    lines=$(wc -l < "$file" 2>/dev/null || echo "0")
                    echo "$file|$size|$lines"
                fi
            done
        `;
        
        log(`[CSV Checker] Executing bash command: ${bashCommand}`);
        const { stdout, stderr } = await execAsync(bashCommand);
        
        if (stderr) {
            logError(`[CSV Checker] Bash stderr: ${stderr}`);
        }
        
        const csvFiles: CSVFileInfo[] = [];
        const lines = stdout.trim().split('\n').filter(line => line.length > 0);
        
        log(`[CSV Checker] Found ${lines.length} CSV file entries`);
        
        for (const line of lines) {
            const [filePath, sizeStr, linesStr] = line.split('|');
            if (filePath && sizeStr && linesStr) {
                const fullPath = path.resolve(workspaceRoot, filePath);
                const csvInfo: CSVFileInfo = {
                    path: fullPath,
                    name: path.basename(filePath),
                    size: parseInt(sizeStr) || 0,
                    lines: parseInt(linesStr) || 0
                };
                
                // Try to read headers
                try {
                    csvInfo.headers = await getCSVHeaders(fullPath);
                } catch (error) {
                    log(`[CSV Checker] Could not read headers for ${filePath}: ${error}`);
                }
                
                csvFiles.push(csvInfo);
                log(`[CSV Checker] Found CSV: ${csvInfo.name} (${csvInfo.size} bytes, ${csvInfo.lines} lines)`);
            }
        }
        
        return csvFiles;
        
    } catch (error) {
        logError(`[CSV Checker] Error executing bash command: ${error}`);
        throw error;
    }
}

/**
 * Get CSV headers from file
 */
async function getCSVHeaders(filePath: string): Promise<string[]> {
    try {
        // Use bash to read just the first line
        const { stdout } = await execAsync(`head -n 1 "${filePath}"`);
        const firstLine = stdout.trim();
        
        if (firstLine) {
            return firstLine.split(',').map(header => header.trim().replace(/"/g, ''));
        }
        
        return [];
    } catch (error) {
        throw new Error(`Could not read CSV headers: ${error}`);
    }
}

/**
 * Generate detailed CSV report using bash commands
 */
export async function generateCSVReport(): Promise<string> {
    try {
        const csvFiles = await checkCSVFilesWithBash();
        
        if (csvFiles.length === 0) {
            return "No CSV files found in this codebase.";
        }
        
        let report = `Found ${csvFiles.length} CSV file${csvFiles.length > 1 ? 's' : ''} in the codebase:\n\n`;
        
        for (const csv of csvFiles) {
            report += `📄 ${csv.name}\n`;
            report += `   Path: ${vscode.workspace.asRelativePath(csv.path)}\n`;
            report += `   Size: ${formatFileSize(csv.size)}\n`;
            report += `   Lines: ${csv.lines}\n`;
            
            if (csv.headers && csv.headers.length > 0) {
                report += `   Columns: ${csv.headers.join(', ')}\n`;
            }
            
            report += '\n';
        }
        
        return report.trim();
        
    } catch (error) {
        logError(`[CSV Report] Error generating report: ${error}`);
        return `Error checking for CSV files: ${error}`;
    }
}

/**
 * Find and analyze a specific CSV file by name
 */
export async function analyzeSpecificCSVFile(fileName: string): Promise<string> {
    try {
        log(`[CSV Analyzer] Looking for CSV file: ${fileName}`);
        
        const csvFiles = await checkCSVFilesWithBash();
        
        // Find the CSV file by name (case-insensitive)
        const targetFile = csvFiles.find(csv => 
            csv.name.toLowerCase() === fileName.toLowerCase() ||
            csv.name.toLowerCase().includes(fileName.toLowerCase().replace('.csv', ''))
        );
        
        if (!targetFile) {
            const availableFiles = csvFiles.map(csv => csv.name).join(', ');
            return `CSV file "${fileName}" not found. Available CSV files: ${availableFiles || 'none'}`;
        }
        
        log(`[CSV Analyzer] Found target file: ${targetFile.path}`);
        
        // Generate detailed analysis
        const analysis = await analyzeCSVWithBash(targetFile.path);
        
        return analysis;
        
    } catch (error) {
        logError(`[CSV Analyzer] Error analyzing specific CSV file: ${error}`);
        return `Error analyzing CSV file "${fileName}": ${error}`;
    }
}

/**
 * Speak analysis of a specific CSV file
 */
export async function speakCSVFileAnalysis(fileName: string): Promise<void> {
    try {
        const csvFiles = await checkCSVFilesWithBash();
        
        // Find the CSV file by name (case-insensitive)
        const targetFile = csvFiles.find(csv => 
            csv.name.toLowerCase() === fileName.toLowerCase() ||
            csv.name.toLowerCase().includes(fileName.toLowerCase().replace('.csv', ''))
        );
        
        if (!targetFile) {
            await speakTokenList([
                { tokens: ['CSV'], category: undefined },
                { tokens: ['file'], category: undefined },
                { tokens: [fileName], category: undefined },
                { tokens: ['not'], category: undefined },
                { tokens: ['found'], category: undefined }
            ]);
            return;
        }
        
        const chunks: TokenChunk[] = [];
        
        // Speak file name and basic info
        chunks.push(
            { tokens: ['Found'], category: undefined },
            { tokens: ['CSV'], category: undefined },
            { tokens: ['file'], category: undefined },
            { tokens: [targetFile.name], category: undefined }
        );
        
        if (targetFile.lines) {
            chunks.push(
                { tokens: ['with'], category: undefined },
                { tokens: [targetFile.lines.toString()], category: undefined },
                { tokens: ['lines'], category: undefined }
            );
        }
        
        if (targetFile.headers && targetFile.headers.length > 0) {
            chunks.push(
                { tokens: ['and'], category: undefined },
                { tokens: [targetFile.headers.length.toString()], category: undefined },
                { tokens: ['columns:'], category: undefined }
            );
            
            // Speak first few column names
            const columnsToSpeak = targetFile.headers.slice(0, 3);
            for (let i = 0; i < columnsToSpeak.length; i++) {
                if (i > 0) {
                    chunks.push({ tokens: [','], category: undefined });
                }
                chunks.push({ tokens: [columnsToSpeak[i]], category: undefined });
            }
            
            if (targetFile.headers.length > 3) {
                chunks.push(
                    { tokens: ['and'], category: undefined },
                    { tokens: [(targetFile.headers.length - 3).toString()], category: undefined },
                    { tokens: ['more'], category: undefined }
                );
            }
        }
        
        await speakTokenList(chunks);
        
    } catch (error) {
        logError(`[CSV Analyzer] Error speaking CSV analysis: ${error}`);
    }
}

/**
 * Speak CSV file information
 */
export async function speakCSVFileInfo(csvFiles: CSVFileInfo[]): Promise<void> {
    try {
        if (csvFiles.length === 0) {
            await speakTokenList([
                { tokens: ['No'], category: undefined },
                { tokens: ['CSV'], category: undefined },
                { tokens: ['files'], category: undefined },
                { tokens: ['found'], category: undefined }
            ]);
            return;
        }
        
        const chunks: TokenChunk[] = [];
        
        if (csvFiles.length === 1) {
            chunks.push(
                { tokens: ['Found'], category: undefined },
                { tokens: ['1'], category: undefined },
                { tokens: ['CSV'], category: undefined },
                { tokens: ['file:'], category: undefined },
                { tokens: [csvFiles[0].name], category: undefined }
            );
            
            if (csvFiles[0].lines) {
                chunks.push(
                    { tokens: ['with'], category: undefined },
                    { tokens: [csvFiles[0].lines.toString()], category: undefined },
                    { tokens: ['lines'], category: undefined }
                );
            }
        } else {
            chunks.push(
                { tokens: ['Found'], category: undefined },
                { tokens: [csvFiles.length.toString()], category: undefined },
                { tokens: ['CSV'], category: undefined },
                { tokens: ['files'], category: undefined }
            );
            
            // Speak first few file names
            const filesToSpeak = csvFiles.slice(0, 3);
            for (let i = 0; i < filesToSpeak.length; i++) {
                if (i > 0) {
                    chunks.push({ tokens: [','], category: undefined });
                }
                chunks.push({ tokens: [filesToSpeak[i].name], category: undefined });
            }
            
            if (csvFiles.length > 3) {
                chunks.push(
                    { tokens: ['and'], category: undefined },
                    { tokens: [(csvFiles.length - 3).toString()], category: undefined },
                    { tokens: ['more'], category: undefined }
                );
            }
        }
        
        await speakTokenList(chunks);
        
    } catch (error) {
        logError(`[CSV Checker] Error speaking CSV info: ${error}`);
    }
}

/**
 * Execute advanced CSV analysis using bash commands
 */
export async function analyzeCSVWithBash(csvPath: string): Promise<string> {
    try {
        log(`[CSV Analyzer] Analyzing CSV file: ${csvPath}`);
        
        // Multi-command bash script for CSV analysis
        const analysisScript = `
            cd "$(dirname "${csvPath}")" &&
            file="${csvPath}" &&
            echo "=== CSV Analysis Report ===" &&
            echo "File: $(basename "$file")" &&
            echo "Size: $(wc -c < "$file") bytes" &&
            echo "Lines: $(wc -l < "$file")" &&
            echo "Columns: $(head -n 1 "$file" | tr ',' '\n' | wc -l)" &&
            echo "" &&
            echo "=== Headers ===" &&
            head -n 1 "$file" | tr ',' '\n' | nl &&
            echo "" &&
            echo "=== Sample Data (first 3 rows) ===" &&
            head -n 4 "$file" &&
            echo "" &&
            echo "=== File Statistics ===" &&
            echo "First row: $(head -n 2 "$file" | tail -n 1)" &&
            echo "Last row: $(tail -n 1 "$file")"
        `;
        
        const { stdout, stderr } = await execAsync(analysisScript);
        
        if (stderr) {
            log(`[CSV Analyzer] Bash stderr: ${stderr}`);
        }
        
        return stdout;
        
    } catch (error) {
        logError(`[CSV Analyzer] Error analyzing CSV: ${error}`);
        throw error;
    }
}

/**
 * Register CSV file checker commands
 */
export function registerCSVFileChecker(context: ExtensionContext) {
    // Command to check CSV files using bash
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.checkCSVFiles', async () => {
            try {
                vscode.window.showInformationMessage('Checking for CSV files...');
                
                const csvFiles = await checkCSVFilesWithBash();
                const report = await generateCSVReport();
                
                // Show report in output panel
                const outputChannel = vscode.window.createOutputChannel('CSV File Report');
                outputChannel.clear();
                outputChannel.appendLine(report);
                outputChannel.show();
                
                // Speak the results
                await speakCSVFileInfo(csvFiles);
                
                logSuccess(`[CSV Checker] Found ${csvFiles.length} CSV files`);
                
            } catch (error) {
                logError(`[CSV Checker] Command failed: ${error}`);
                vscode.window.showErrorMessage(`Error checking CSV files: ${error}`);
            }
        })
    );
    
    // Command to analyze specific CSV file
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.analyzeCSVFile', async () => {
            try {
                const csvFiles = await checkCSVFilesWithBash();
                
                if (csvFiles.length === 0) {
                    vscode.window.showInformationMessage('No CSV files found in workspace');
                    return;
                }
                
                // Let user select CSV file to analyze
                const items = csvFiles.map(csv => ({
                    label: csv.name,
                    description: `${csv.lines} lines, ${formatFileSize(csv.size)}`,
                    detail: vscode.workspace.asRelativePath(csv.path),
                    csv
                }));
                
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select CSV file to analyze'
                });
                
                if (selected) {
                    vscode.window.showInformationMessage(`Analyzing ${selected.csv.name}...`);
                    
                    const analysis = await analyzeCSVWithBash(selected.csv.path);
                    
                    // Show analysis in output panel
                    const outputChannel = vscode.window.createOutputChannel('CSV Analysis');
                    outputChannel.clear();
                    outputChannel.appendLine(analysis);
                    outputChannel.show();
                    
                    await speakTokenList([
                        { tokens: ['CSV'], category: undefined },
                        { tokens: ['analysis'], category: undefined },
                        { tokens: ['complete'], category: undefined }
                    ]);
                }
                
            } catch (error) {
                logError(`[CSV Analyzer] Command failed: ${error}`);
                vscode.window.showErrorMessage(`Error analyzing CSV: ${error}`);
            }
        })
    );
    
    // Command to analyze specific CSV file by name (for ASR)
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.analyzeSpecificCSVFile', async (fileName?: string) => {
            try {
                if (!fileName) {
                    vscode.window.showErrorMessage('No CSV file name provided');
                    return;
                }
                
                log(`[CSV Analyzer] Analyzing specific CSV file: ${fileName}`);
                
                // Analyze the specific CSV file
                const analysis = await analyzeSpecificCSVFile(fileName);
                
                // Show analysis in output panel
                const outputChannel = vscode.window.createOutputChannel('CSV File Analysis');
                outputChannel.clear();
                outputChannel.appendLine(analysis);
                outputChannel.show();
                
                // Speak the analysis
                await speakCSVFileAnalysis(fileName);
                
                logSuccess(`[CSV Analyzer] Analysis complete for ${fileName}`);
                
            } catch (error) {
                logError(`[CSV Analyzer] Command failed: ${error}`);
                vscode.window.showErrorMessage(`Error analyzing CSV file: ${error}`);
            }
        })
    );
}

// Utility function
function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
