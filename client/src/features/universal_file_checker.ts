import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionContext } from 'vscode';
import { speakTokenList, TokenChunk } from '../audio';
import { log, logError, logSuccess } from '../utils';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface FileInfo {
    path: string;
    name: string;
    size: number;
    lines?: number;
    extension: string;
    type: 'file' | 'directory';
}

export interface FileSearchResult {
    query: string;
    files: FileInfo[];
    totalFound: number;
    searchTime: number;
}

/**
 * Execute bash script to find files by extension or name pattern
 */
export async function findFilesWithBash(pattern: string): Promise<FileSearchResult> {
    const startTime = Date.now();
    
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('No workspace folder open');
        }
        
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        log(`[Universal File Checker] Searching for files matching: ${pattern} in: ${workspaceRoot}`);
        
        // Create bash command to find files by pattern
        let findCommand: string;
        
        if (pattern.startsWith('*.')) {
            // Extension search (e.g., *.json, *.py)
            findCommand = `find . -name "${pattern}" -type f 2>/dev/null`;
        } else if (pattern.includes('*')) {
            // Wildcard search (e.g., *university*, test*)
            findCommand = `find . -name "${pattern}" -type f 2>/dev/null`;
        } else {
            // Exact name or partial name search
            findCommand = `find . -name "*${pattern}*" -type f 2>/dev/null`;
        }
        
        const bashCommand = `
            cd "${workspaceRoot}" && 
            ${findCommand} | 
            head -50 |
            while read -r file; do
                if [ -f "$file" ]; then
                    size=$(wc -c < "$file" 2>/dev/null || echo "0")
                    lines=$(wc -l < "$file" 2>/dev/null || echo "0")
                    echo "$file|$size|$lines"
                fi
            done
        `;
        
        log(`[Universal File Checker] Executing bash command: ${findCommand}`);
        const { stdout, stderr } = await execAsync(bashCommand);
        
        if (stderr) {
            log(`[Universal File Checker] Bash stderr: ${stderr}`);
        }
        
        const files: FileInfo[] = [];
        const lines = stdout.trim().split('\n').filter(line => line.length > 0);
        
        log(`[Universal File Checker] Found ${lines.length} file entries`);
        
        for (const line of lines) {
            const [filePath, sizeStr, linesStr] = line.split('|');
            if (filePath && sizeStr && linesStr) {
                const fullPath = path.resolve(workspaceRoot, filePath);
                const fileInfo: FileInfo = {
                    path: fullPath,
                    name: path.basename(filePath),
                    size: parseInt(sizeStr) || 0,
                    lines: parseInt(linesStr) || 0,
                    extension: path.extname(filePath),
                    type: 'file'
                };
                
                files.push(fileInfo);
                log(`[Universal File Checker] Found: ${fileInfo.name} (${fileInfo.size} bytes, ${fileInfo.lines} lines)`);
            }
        }
        
        const searchTime = Date.now() - startTime;
        
        return {
            query: pattern,
            files,
            totalFound: files.length,
            searchTime
        };
        
    } catch (error) {
        logError(`[Universal File Checker] Error executing bash command: ${error}`);
        throw error;
    }
}

/**
 * Find and open a specific file
 */
export async function findAndOpenFile(fileName: string): Promise<boolean> {
    try {
        log(`[Universal File Checker] Looking for file: ${fileName}`);
        
        // Search for the file
        const searchResult = await findFilesWithBash(fileName);
        
        if (searchResult.files.length === 0) {
            // Try different search patterns
            const alternativePatterns = [
                `*${fileName}*`,
                `${fileName}.*`,
                `*.${fileName}`,
                fileName.replace(/\.[^/.]+$/, "") // Remove extension if present
            ];
            
            for (const pattern of alternativePatterns) {
                const altResult = await findFilesWithBash(pattern);
                if (altResult.files.length > 0) {
                    searchResult.files = altResult.files;
                    break;
                }
            }
        }
        
        if (searchResult.files.length === 0) {
            await speakTokenList([
                { tokens: ['File'], category: undefined },
                { tokens: [fileName], category: undefined },
                { tokens: ['not'], category: undefined },
                { tokens: ['found'], category: undefined }
            ]);
            
            vscode.window.showWarningMessage(`File "${fileName}" not found in workspace`);
            return false;
        }
        
        let fileToOpen: FileInfo;
        
        if (searchResult.files.length === 1) {
            fileToOpen = searchResult.files[0];
        } else {
            // Multiple files found, let user choose
            const items = searchResult.files.map(file => ({
                label: file.name,
                description: `${formatFileSize(file.size)} - ${file.lines} lines`,
                detail: vscode.workspace.asRelativePath(file.path),
                file
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `Found ${searchResult.files.length} files matching "${fileName}". Select one to open:`
            });
            
            if (!selected) {
                return false; // User cancelled
            }
            
            fileToOpen = selected.file;
        }
        
        // Open the file
        const document = await vscode.workspace.openTextDocument(fileToOpen.path);
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
        
        await speakTokenList([
            { tokens: ['Opened'], category: undefined },
            { tokens: [fileToOpen.name], category: undefined },
            { tokens: ['in'], category: undefined },
            { tokens: ['editor'], category: undefined }
        ]);
        
        logSuccess(`[Universal File Checker] Opened file: ${fileToOpen.name}`);
        return true;
        
    } catch (error) {
        logError(`[Universal File Checker] Error opening file: ${error}`);
        vscode.window.showErrorMessage(`Error opening file "${fileName}": ${error}`);
        return false;
    }
}

/**
 * Generate detailed file report using bash commands
 */
export async function generateFileReport(searchResult: FileSearchResult): Promise<string> {
    try {
        if (searchResult.files.length === 0) {
            return `No files found matching "${searchResult.query}".`;
        }
        
        let report = `Found ${searchResult.files.length} file${searchResult.files.length > 1 ? 's' : ''} matching "${searchResult.query}" (${searchResult.searchTime}ms):\n\n`;
        
        // Group by extension
        const byExtension: { [key: string]: FileInfo[] } = {};
        for (const file of searchResult.files) {
            const ext = file.extension || 'no extension';
            if (!byExtension[ext]) {
                byExtension[ext] = [];
            }
            byExtension[ext].push(file);
        }
        
        for (const [ext, files] of Object.entries(byExtension)) {
            report += `📁 ${ext} files (${files.length}):\n`;
            
            for (const file of files.slice(0, 10)) { // Limit to 10 per extension
                report += `   📄 ${file.name}\n`;
                report += `      Path: ${vscode.workspace.asRelativePath(file.path)}\n`;
                report += `      Size: ${formatFileSize(file.size)}\n`;
                if (file.lines && file.lines > 0) {
                    report += `      Lines: ${file.lines}\n`;
                }
                report += '\n';
            }
            
            if (files.length > 10) {
                report += `   ... and ${files.length - 10} more ${ext} files\n\n`;
            }
        }
        
        return report.trim();
        
    } catch (error) {
        logError(`[Universal File Checker] Error generating report: ${error}`);
        return `Error generating file report: ${error}`;
    }
}

/**
 * Speak file search results
 */
export async function speakFileSearchResults(searchResult: FileSearchResult): Promise<void> {
    try {
        const chunks: TokenChunk[] = [];
        
        if (searchResult.files.length === 0) {
            chunks.push(
                { tokens: ['No'], category: undefined },
                { tokens: ['files'], category: undefined },
                { tokens: ['found'], category: undefined },
                { tokens: ['matching'], category: undefined },
                { tokens: [searchResult.query], category: undefined }
            );
        } else if (searchResult.files.length === 1) {
            const file = searchResult.files[0];
            chunks.push(
                { tokens: ['Found'], category: undefined },
                { tokens: ['1'], category: undefined },
                { tokens: ['file:'], category: undefined },
                { tokens: [file.name], category: undefined }
            );
            
            if (file.lines && file.lines > 0) {
                chunks.push(
                    { tokens: ['with'], category: undefined },
                    { tokens: [file.lines.toString()], category: undefined },
                    { tokens: ['lines'], category: undefined }
                );
            }
        } else {
            chunks.push(
                { tokens: ['Found'], category: undefined },
                { tokens: [searchResult.files.length.toString()], category: undefined },
                { tokens: ['files'], category: undefined },
                { tokens: ['matching'], category: undefined },
                { tokens: [searchResult.query], category: undefined }
            );
            
            // Speak first few file names
            const filesToSpeak = searchResult.files.slice(0, 3);
            for (let i = 0; i < filesToSpeak.length; i++) {
                if (i === 0) {
                    chunks.push({ tokens: [':'], category: undefined });
                } else {
                    chunks.push({ tokens: [','], category: undefined });
                }
                chunks.push({ tokens: [filesToSpeak[i].name], category: undefined });
            }
            
            if (searchResult.files.length > 3) {
                chunks.push(
                    { tokens: ['and'], category: undefined },
                    { tokens: [(searchResult.files.length - 3).toString()], category: undefined },
                    { tokens: ['more'], category: undefined }
                );
            }
        }
        
        await speakTokenList(chunks);
        
    } catch (error) {
        logError(`[Universal File Checker] Error speaking results: ${error}`);
    }
}

/**
 * Get file statistics using bash
 */
export async function getFileStatistics(filePath: string): Promise<string> {
    try {
        const analysisScript = `
            file="${filePath}" &&
            echo "=== File Analysis ===" &&
            echo "Name: $(basename "$file")" &&
            echo "Size: $(wc -c < "$file" 2>/dev/null || echo "0") bytes" &&
            echo "Lines: $(wc -l < "$file" 2>/dev/null || echo "0")" &&
            echo "Words: $(wc -w < "$file" 2>/dev/null || echo "0")" &&
            echo "Characters: $(wc -m < "$file" 2>/dev/null || echo "0")" &&
            echo "" &&
            echo "=== File Type ===" &&
            file "$file" 2>/dev/null || echo "Unknown file type" &&
            echo "" &&
            echo "=== First 5 lines ===" &&
            head -n 5 "$file" 2>/dev/null || echo "Cannot read file content" &&
            echo "" &&
            echo "=== Last 5 lines ===" &&
            tail -n 5 "$file" 2>/dev/null || echo "Cannot read file content"
        `;
        
        const { stdout } = await execAsync(analysisScript);
        return stdout;
        
    } catch (error) {
        logError(`[Universal File Checker] Error analyzing file: ${error}`);
        throw error;
    }
}

/**
 * Register universal file checker commands
 */
export function registerUniversalFileChecker(context: ExtensionContext) {
    // Command to search for any file type
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.findAnyFiles', async () => {
            try {
                const pattern = await vscode.window.showInputBox({
                    prompt: 'Enter file pattern (e.g., *.json, university, test*)',
                    placeHolder: '*.json'
                });
                
                if (!pattern) return;
                
                vscode.window.showInformationMessage(`Searching for files matching "${pattern}"...`);
                
                const searchResult = await findFilesWithBash(pattern);
                const report = await generateFileReport(searchResult);
                
                // Show report in output panel
                const outputChannel = vscode.window.createOutputChannel('File Search Report');
                outputChannel.clear();
                outputChannel.appendLine(report);
                outputChannel.show();
                
                // Speak the results
                await speakFileSearchResults(searchResult);
                
                logSuccess(`[Universal File Checker] Found ${searchResult.files.length} files matching "${pattern}"`);
                
            } catch (error) {
                logError(`[Universal File Checker] Command failed: ${error}`);
                vscode.window.showErrorMessage(`Error searching files: ${error}`);
            }
        })
    );
    
    // Command to find and open specific file
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.openFileByName', async () => {
            try {
                const fileName = await vscode.window.showInputBox({
                    prompt: 'Enter file name to open (e.g., university.py, config.json)',
                    placeHolder: 'university.py'
                });
                
                if (!fileName) return;
                
                vscode.window.showInformationMessage(`Looking for "${fileName}"...`);
                
                const success = await findAndOpenFile(fileName);
                
                if (!success) {
                    // Offer to search for similar files
                    const searchSimilar = await vscode.window.showQuickPick([
                        { label: 'Yes', value: true },
                        { label: 'No', value: false }
                    ], {
                        placeHolder: `File "${fileName}" not found. Search for similar files?`
                    });
                    
                    if (searchSimilar?.value) {
                        const searchResult = await findFilesWithBash(`*${fileName.split('.')[0]}*`);
                        if (searchResult.files.length > 0) {
                            await speakFileSearchResults(searchResult);
                            
                            const items = searchResult.files.map(file => ({
                                label: file.name,
                                description: `${formatFileSize(file.size)} - ${file.lines} lines`,
                                detail: vscode.workspace.asRelativePath(file.path),
                                file
                            }));
                            
                            const selected = await vscode.window.showQuickPick(items, {
                                placeHolder: 'Select a file to open:'
                            });
                            
                            if (selected) {
                                const document = await vscode.workspace.openTextDocument(selected.file.path);
                                await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
                                
                                await speakTokenList([
                                    { tokens: ['Opened'], category: undefined },
                                    { tokens: [selected.file.name], category: undefined }
                                ]);
                            }
                        }
                    }
                }
                
            } catch (error) {
                logError(`[Universal File Checker] Open file command failed: ${error}`);
                vscode.window.showErrorMessage(`Error opening file: ${error}`);
            }
        })
    );
    
    // Command to analyze specific file
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.analyzeFile', async () => {
            try {
                const fileName = await vscode.window.showInputBox({
                    prompt: 'Enter file name to analyze',
                    placeHolder: 'university.py'
                });
                
                if (!fileName) return;
                
                const searchResult = await findFilesWithBash(fileName);
                
                if (searchResult.files.length === 0) {
                    vscode.window.showWarningMessage(`File "${fileName}" not found`);
                    return;
                }
                
                let fileToAnalyze: FileInfo;
                
                if (searchResult.files.length === 1) {
                    fileToAnalyze = searchResult.files[0];
                } else {
                    const items = searchResult.files.map(file => ({
                        label: file.name,
                        description: `${formatFileSize(file.size)} - ${file.lines} lines`,
                        detail: vscode.workspace.asRelativePath(file.path),
                        file
                    }));
                    
                    const selected = await vscode.window.showQuickPick(items, {
                        placeHolder: 'Select file to analyze:'
                    });
                    
                    if (!selected) return;
                    fileToAnalyze = selected.file;
                }
                
                vscode.window.showInformationMessage(`Analyzing ${fileToAnalyze.name}...`);
                
                const analysis = await getFileStatistics(fileToAnalyze.path);
                
                // Show analysis in output panel
                const outputChannel = vscode.window.createOutputChannel('File Analysis');
                outputChannel.clear();
                outputChannel.appendLine(analysis);
                outputChannel.show();
                
                await speakTokenList([
                    { tokens: ['File'], category: undefined },
                    { tokens: ['analysis'], category: undefined },
                    { tokens: ['complete'], category: undefined }
                ]);
                
            } catch (error) {
                logError(`[Universal File Checker] Analyze file command failed: ${error}`);
                vscode.window.showErrorMessage(`Error analyzing file: ${error}`);
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
