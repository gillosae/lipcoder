import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ExtensionContext } from 'vscode';
import { speakTokenList, speakGPT, TokenChunk } from '../audio';
import { stopReading, lineAbortController } from './stop_reading';
import { log, logError } from '../utils';

interface FileSearchResult {
    name: string;
    path: string;
    size: number;
    modified: Date;
    isDirectory: boolean;
    extension?: string;
}

interface FileContent {
    path: string;
    content: string;
    lines: number;
    encoding: string;
}

export function registerFileSearchExplorer(context: ExtensionContext) {
    // Command 1: Find files by pattern or extension
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.findFiles', async () => {
            stopReading();
            
            const pattern = await vscode.window.showInputBox({
                prompt: 'Enter file pattern or extension (e.g., *.csv, *.ts, config)',
                placeHolder: '*.csv'
            });
            
            if (!pattern) return;
            
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }
            
            try {
                const results = await searchFiles(workspaceFolders[0].uri.fsPath, pattern);
                await displayFileSearchResults(results, pattern);
            } catch (error) {
                logError(`Error searching files: ${error}`);
                vscode.window.showErrorMessage(`Error searching files: ${error}`);
            }
        })
    );

    // Command 2: Quick examine file content
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.examineFile', async () => {
            stopReading();
            
            const filePath = await vscode.window.showInputBox({
                prompt: 'Enter file path to examine',
                placeHolder: 'sample_data.csv'
            });
            
            if (!filePath) return;
            
            try {
                const fullPath = path.resolve(vscode.workspace.workspaceFolders![0].uri.fsPath, filePath);
                const content = await examineFileContent(fullPath);
                await displayFileContent(content);
            } catch (error) {
                logError(`Error examining file: ${error}`);
                vscode.window.showErrorMessage(`Error examining file: ${error}`);
            }
        })
    );

    // Command 3: Find and examine CSV files specifically
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.findCsvFiles', async () => {
            stopReading();
            
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }
            
            try {
                const csvFiles = await searchFiles(workspaceFolders[0].uri.fsPath, '*.csv');
                
                if (csvFiles.length === 0) {
                    vscode.window.showInformationMessage('No CSV files found in workspace');
                    await speakGPT('No CSV files found');
                    return;
                }
                
                await displayCsvFileResults(csvFiles);
            } catch (error) {
                logError(`Error searching CSV files: ${error}`);
                vscode.window.showErrorMessage(`Error searching CSV files: ${error}`);
            }
        })
    );

    // Command 4: Interactive file browser
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.interactiveFileBrowser', async () => {
            stopReading();
            await showInteractiveFileBrowser();
        })
    );

    // Command 5: Create function based on CSV structure
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.createCsvFunction', async () => {
            stopReading();
            
            const csvPath = await vscode.window.showInputBox({
                prompt: 'Enter CSV file path',
                placeHolder: 'sample_data.csv'
            });
            
            if (!csvPath) return;
            
            try {
                const fullPath = path.resolve(vscode.workspace.workspaceFolders![0].uri.fsPath, csvPath);
                await createFunctionFromCsv(fullPath);
            } catch (error) {
                logError(`Error creating function from CSV: ${error}`);
                vscode.window.showErrorMessage(`Error creating function from CSV: ${error}`);
            }
        })
    );
}

async function searchFiles(rootPath: string, pattern: string): Promise<FileSearchResult[]> {
    const results: FileSearchResult[] = [];
    
    // Convert pattern to regex
    const regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    
    const regex = new RegExp(regexPattern, 'i');
    
    async function searchDirectory(dirPath: string) {
        try {
            // Check if aborted
            if (lineAbortController.signal.aborted) {
                log('[FileSearch] Search aborted');
                return;
            }
            
            const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
            
            for (const item of items) {
                // Check if aborted during iteration
                if (lineAbortController.signal.aborted) {
                    log('[FileSearch] Search aborted during iteration');
                    return;
                }
                
                if (item.name.startsWith('.')) continue; // Skip hidden files
                
                const itemPath = path.join(dirPath, item.name);
                
                if (item.isDirectory()) {
                    // Recursively search subdirectories
                    await searchDirectory(itemPath);
                } else if (item.isFile()) {
                    // Check if file matches pattern
                    if (regex.test(item.name)) {
                        const stats = await fs.promises.stat(itemPath);
                        results.push({
                            name: item.name,
                            path: itemPath,
                            size: stats.size,
                            modified: stats.mtime,
                            isDirectory: false,
                            extension: path.extname(item.name)
                        });
                    }
                }
            }
        } catch (error) {
            logError(`Error reading directory ${dirPath}: ${error}`);
        }
    }
    
    await searchDirectory(rootPath);
    return results.sort((a, b) => a.name.localeCompare(b.name));
}

async function examineFileContent(filePath: string): Promise<FileContent> {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const lines = content.split('\n').length;
    
    return {
        path: filePath,
        content,
        lines,
        encoding: 'utf8'
    };
}

async function displayFileSearchResults(results: FileSearchResult[], pattern: string) {
    if (results.length === 0) {
        vscode.window.showInformationMessage(`No files found matching pattern: ${pattern}`);
        await speakGPT('No files found');
        return;
    }
    
    const items = results.map(result => ({
        label: result.name,
        description: `${formatFileSize(result.size)} - ${result.modified.toLocaleDateString()}`,
        detail: result.path,
        result
    }));
    
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Found ${results.length} files matching "${pattern}". Select one to examine:`,
        matchOnDescription: true,
        matchOnDetail: true
    });
    
    if (selected) {
        await speakGPT(`Selected ${selected.result.name}`);
        
        // Ask what to do with the selected file
        const action = await vscode.window.showQuickPick([
            { label: 'Open in Editor', value: 'open' },
            { label: 'Examine Content', value: 'examine' },
            { label: 'Show File Info', value: 'info' },
            { label: 'Copy Path', value: 'copy' }
        ], {
            placeHolder: 'What would you like to do with this file?'
        });
        
        if (action) {
            await handleFileAction(selected.result, action.value);
        }
    }
}

async function displayCsvFileResults(csvFiles: FileSearchResult[]) {
    const items = csvFiles.map(file => ({
        label: file.name,
        description: `${formatFileSize(file.size)} - ${file.modified.toLocaleDateString()}`,
        detail: file.path,
        file
    }));
    
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Found ${csvFiles.length} CSV files. Select one to examine:`,
        matchOnDescription: true,
        matchOnDetail: true
    });
    
    if (selected) {
        await speakGPT(`Selected CSV file ${selected.file.name}`);
        
        // Automatically examine CSV structure
        const content = await examineFileContent(selected.file.path);
        await displayCsvStructure(content);
    }
}

async function displayFileContent(content: FileContent) {
    const relativePath = vscode.workspace.asRelativePath(content.path);
    const preview = content.content.substring(0, 500);
    const truncated = content.content.length > 500 ? '...' : '';
    
    const panel = vscode.window.createWebviewPanel(
        'fileExaminer',
        `File: ${path.basename(content.path)}`,
        vscode.ViewColumn.Beside,
        { enableScripts: false }
    );
    
    panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>File Examiner</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; }
                .header { background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
                .content { background: #fafafa; padding: 15px; border-radius: 5px; white-space: pre-wrap; font-family: monospace; }
                .info { color: #666; margin-bottom: 10px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h2>📄 ${path.basename(content.path)}</h2>
                <div class="info">Path: ${relativePath}</div>
                <div class="info">Lines: ${content.lines}</div>
                <div class="info">Size: ${formatFileSize(content.content.length)}</div>
            </div>
            <div class="content">${escapeHtml(preview)}${truncated}</div>
        </body>
        </html>
    `;
    
    await speakTokenList([
        { tokens: ['File examined:', path.basename(content.path)], category: undefined },
        { tokens: [`${content.lines} lines`], category: undefined }
    ]);
}

async function displayCsvStructure(content: FileContent) {
    const lines = content.content.split('\n').filter(line => line.trim());
    if (lines.length === 0) {
        vscode.window.showWarningMessage('CSV file is empty');
        return;
    }
    
    const headers = lines[0].split(',').map(h => h.trim());
    const dataRows = lines.slice(1);
    const sampleData = dataRows.slice(0, 3); // First 3 rows as sample
    
    const panel = vscode.window.createWebviewPanel(
        'csvExaminer',
        `CSV: ${path.basename(content.path)}`,
        vscode.ViewColumn.Beside,
        { enableScripts: false }
    );
    
    panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>CSV Examiner</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; }
                .header { background: #e8f4fd; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
                .structure { background: #f9f9f9; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
                .sample { background: #fff; border: 1px solid #ddd; border-radius: 5px; }
                table { width: 100%; border-collapse: collapse; }
                th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #ddd; }
                th { background: #f5f5f5; font-weight: bold; }
                .info { color: #666; margin-bottom: 10px; }
                .column { background: #f0f8ff; padding: 5px 10px; margin: 2px; border-radius: 3px; display: inline-block; }
            </style>
        </head>
        <body>
            <div class="header">
                <h2>📊 CSV Structure: ${path.basename(content.path)}</h2>
                <div class="info">Total rows: ${dataRows.length + 1} (including header)</div>
                <div class="info">Columns: ${headers.length}</div>
            </div>
            
            <div class="structure">
                <h3>Column Structure:</h3>
                ${headers.map((header, i) => `<span class="column">${i + 1}. ${header}</span>`).join('')}
            </div>
            
            <div class="sample">
                <h3>Sample Data (first 3 rows):</h3>
                <table>
                    <thead>
                        <tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>
                    </thead>
                    <tbody>
                        ${sampleData.map(row => {
                            const cells = row.split(',').map(cell => cell.trim());
                            return `<tr>${cells.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </body>
        </html>
    `;
    
    await speakTokenList([
        { tokens: ['CSV structure analyzed'], category: undefined },
        { tokens: [`${headers.length} columns`], category: undefined },
        { tokens: [`${dataRows.length} data rows`], category: undefined }
    ]);
    
    // Offer to create function based on this CSV
    const createFunction = await vscode.window.showQuickPick([
        { label: 'Yes', value: true },
        { label: 'No', value: false }
    ], {
        placeHolder: 'Would you like to create a function to process this CSV data?'
    });
    
    if (createFunction?.value) {
        await createFunctionFromCsvStructure(headers, content.path);
    }
}

async function createFunctionFromCsv(csvPath: string) {
    const content = await examineFileContent(csvPath);
    const lines = content.content.split('\n').filter(line => line.trim());
    
    if (lines.length === 0) {
        vscode.window.showWarningMessage('CSV file is empty');
        return;
    }
    
    const headers = lines[0].split(',').map(h => h.trim());
    await createFunctionFromCsvStructure(headers, csvPath);
}

async function createFunctionFromCsvStructure(headers: string[], csvPath: string) {
    const fileName = path.basename(csvPath, '.csv');
    const functionName = `process${fileName.charAt(0).toUpperCase() + fileName.slice(1)}`;
    
    // Generate TypeScript interface and function
    const interfaceName = `${fileName.charAt(0).toUpperCase() + fileName.slice(1)}Record`;
    
    const tsCode = `
// Generated from CSV: ${path.basename(csvPath)}
interface ${interfaceName} {
${headers.map(header => `    ${toCamelCase(header)}: string;`).join('\n')}
}

async function ${functionName}(csvFilePath: string): Promise<${interfaceName}[]> {
    const fs = require('fs').promises;
    const content = await fs.readFile(csvFilePath, 'utf8');
    const lines = content.split('\\n').filter(line => line.trim());
    
    if (lines.length === 0) {
        return [];
    }
    
    // Skip header row
    const dataLines = lines.slice(1);
    const records: ${interfaceName}[] = [];
    
    for (const line of dataLines) {
        const values = line.split(',').map(v => v.trim());
        if (values.length === ${headers.length}) {
            records.push({
${headers.map((header, i) => `                ${toCamelCase(header)}: values[${i}]`).join(',\n')}
            });
        }
    }
    
    return records;
}

// Example usage functions
async function find${interfaceName}ByField(records: ${interfaceName}[], field: keyof ${interfaceName}, value: string): Promise<${interfaceName}[]> {
    return records.filter(record => record[field] === value);
}

async function get${interfaceName}Statistics(records: ${interfaceName}[]): Promise<{total: number, fields: string[]}> {
    return {
        total: records.length,
        fields: [${headers.map(h => `'${toCamelCase(h)}'`).join(', ')}]
    };
}

// Export the functions
export { ${functionName}, find${interfaceName}ByField, get${interfaceName}Statistics };
export type { ${interfaceName} };
`;

    // Create the file
    const outputPath = path.join(path.dirname(csvPath), `${fileName}_processor.ts`);
    await fs.promises.writeFile(outputPath, tsCode.trim());
    
    // Open the generated file
    const doc = await vscode.workspace.openTextDocument(outputPath);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    
    vscode.window.showInformationMessage(`Generated TypeScript processor: ${path.basename(outputPath)}`);
    await speakTokenList([
        { tokens: ['Function created:', functionName], category: undefined },
        { tokens: ['File opened in editor'], category: undefined }
    ]);
}

async function showInteractiveFileBrowser() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }
    
    let currentPath = workspaceFolders[0].uri.fsPath;
    
    while (true) {
        try {
            const items = await fs.promises.readdir(currentPath, { withFileTypes: true });
            const quickPickItems = [];
            
            // Add parent directory option if not at root
            if (currentPath !== workspaceFolders[0].uri.fsPath) {
                quickPickItems.push({
                    label: '📁 ..',
                    description: 'Parent directory',
                    detail: path.dirname(currentPath),
                    isDirectory: true,
                    isParent: true,
                    fullPath: path.dirname(currentPath)
                });
            }
            
            // Add directories first
            const directories = items
                .filter(item => item.isDirectory() && !item.name.startsWith('.'))
                .sort((a, b) => a.name.localeCompare(b.name));
            
            for (const dir of directories) {
                quickPickItems.push({
                    label: `📁 ${dir.name}`,
                    description: 'Directory',
                    detail: path.join(currentPath, dir.name),
                    isDirectory: true,
                    isParent: false,
                    fullPath: path.join(currentPath, dir.name)
                });
            }
            
            // Add files
            const files = items
                .filter(item => item.isFile() && !item.name.startsWith('.'))
                .sort((a, b) => a.name.localeCompare(b.name));
            
            for (const file of files) {
                const filePath = path.join(currentPath, file.name);
                const stats = await fs.promises.stat(filePath);
                quickPickItems.push({
                    label: `📄 ${file.name}`,
                    description: `${formatFileSize(stats.size)} - ${stats.mtime.toLocaleDateString()}`,
                    detail: filePath,
                    isDirectory: false,
                    isParent: false,
                    fullPath: filePath
                });
            }
            
            const selected = await vscode.window.showQuickPick(quickPickItems, {
                placeHolder: `Browse: ${vscode.workspace.asRelativePath(currentPath)}`,
                matchOnDescription: true,
                matchOnDetail: true
            });
            
            if (!selected) break; // User cancelled
            
            if (selected.isDirectory) {
                currentPath = selected.fullPath;
                await speakGPT(`Entered ${path.basename(selected.fullPath)}`);
            } else {
                // It's a file, ask what to do
                const action = await vscode.window.showQuickPick([
                    { label: 'Open in Editor', value: 'open' },
                    { label: 'Examine Content', value: 'examine' },
                    { label: 'Show File Info', value: 'info' },
                    { label: 'Copy Path', value: 'copy' },
                    { label: 'Continue Browsing', value: 'continue' }
                ], {
                    placeHolder: `Selected: ${selected.label.substring(2)} - What would you like to do?`
                });
                
                if (action && action.value !== 'continue') {
                    const fileResult: FileSearchResult = {
                        name: path.basename(selected.fullPath),
                        path: selected.fullPath,
                        size: 0,
                        modified: new Date(),
                        isDirectory: false,
                        extension: path.extname(selected.fullPath)
                    };
                    await handleFileAction(fileResult, action.value);
                    if (action.value === 'open') break; // Exit browser after opening file
                }
            }
        } catch (error) {
            logError(`Error browsing directory ${currentPath}: ${error}`);
            vscode.window.showErrorMessage(`Error browsing directory: ${error}`);
            break;
        }
    }
}

async function handleFileAction(file: FileSearchResult, action: string) {
    switch (action) {
        case 'open':
            const doc = await vscode.workspace.openTextDocument(file.path);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            await speakGPT(`Opened ${file.name} in editor`);
            break;
            
        case 'examine':
            const content = await examineFileContent(file.path);
            if (file.extension === '.csv') {
                await displayCsvStructure(content);
            } else {
                await displayFileContent(content);
            }
            break;
            
        case 'info':
            const stats = await fs.promises.stat(file.path);
            const info = `
File: ${file.name}
Path: ${vscode.workspace.asRelativePath(file.path)}
Size: ${formatFileSize(stats.size)}
Modified: ${stats.mtime.toLocaleString()}
Created: ${stats.birthtime.toLocaleString()}
Extension: ${file.extension || 'none'}
            `.trim();
            
            vscode.window.showInformationMessage(info, { modal: true });
            await speakGPT('File info displayed');
            break;
            
        case 'copy':
            await vscode.env.clipboard.writeText(file.path);
            vscode.window.showInformationMessage(`Copied path: ${file.path}`);
            await speakGPT('Path copied to clipboard');
            break;
    }
}

// Utility functions
function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toCamelCase(str: string): string {
    return str
        .replace(/[^a-zA-Z0-9]/g, ' ')
        .split(' ')
        .map((word, index) => {
            if (index === 0) {
                return word.toLowerCase();
            }
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join('');
}
