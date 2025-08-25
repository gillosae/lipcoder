import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as diff from 'diff';
import { log } from '../utils';
import { speakTokenList, TokenChunk } from '../audio';
import { logFeatureUsage } from '../activity_logger';
import { callLLMForCompletion } from '../llm';
import { showIntelligentSuggestions } from './intelligent_suggestions';

interface CodeEditRequest {
    instruction: string;
    targetFile?: string;
    targetFunction?: string;
    targetClass?: string;
}

interface FileSearchResult {
    filePath: string;
    confidence: number;
    reason: string;
}

interface EditResult {
    originalContent: string;
    modifiedContent: string;
    filePath: string;
    summary: string;
    changes: {
        added: number;
        removed: number;
        modified: number;
    };
}

/**
 * Main ASR code editing workflow
 */
export async function executeASRCodeEdit(instruction: string): Promise<void> {
    try {
        log(`[ASR Code Edit] Starting workflow with instruction: "${instruction}"`);
        
        // Step 1: Find target code using bash script and LLM
        await speakTokenList([{ tokens: ['Finding target code...'], category: undefined }]);
        let targetFile = await findTargetCodeFile(instruction);
        
        if (!targetFile) {
            // Ask user to specify the file
            const workspaceFiles = await getWorkspaceCodeFiles();
            const fileOptions = workspaceFiles.map(f => ({
                label: path.basename(f),
                description: path.dirname(f),
                filePath: f
            }));
            
            const selectedFile = await vscode.window.showQuickPick(fileOptions, {
                placeHolder: 'Which file would you like to edit?',
                title: 'Select Target File for Code Editing'
            });
            
            if (!selectedFile) {
                await speakTokenList([{ tokens: ['No file selected'], category: undefined }]);
                return;
            }
            
            targetFile = {
                filePath: selectedFile.filePath,
                confidence: 1.0,
                reason: 'User selected file'
            };
            
            log(`[ASR Code Edit] User selected file: ${targetFile.filePath}`);
        }
        
        // Confirm target file with user
        const fileName = path.basename(targetFile.filePath);
        await speakTokenList([{ tokens: [`Targeting file: ${fileName}`], category: undefined }]);
        log(`[ASR Code Edit] Target file confirmed: ${targetFile.filePath} (${targetFile.reason})`);
        
        // Step 2: Retrieve content using cat
        await speakTokenList([{ tokens: ['Retrieving code content...'], category: undefined }]);
        const content = await retrieveFileContent(targetFile.filePath);
        
        // Step 3: Edit using LLM and save with diff visualization
        await speakTokenList([{ tokens: ['Processing code changes...'], category: undefined }]);
        const editResult = await editCodeWithLLM(content, instruction, targetFile.filePath);
        
        // Step 4: Show diff and save changes
        await showDiffAndSave(editResult);
        
        // Step 5: Summarize changes and speak them
        await summarizeAndSpeakChanges(editResult);
        
        // Step 6: Show intelligent suggestions
        await showIntelligentSuggestions(
            editResult.modifiedContent, 
            editResult.filePath, 
            getLanguageFromExtension,
            executeASRCodeEdit
        );
        
        logFeatureUsage('asr_code_edit_completed', JSON.stringify({ 
            instruction, 
            targetFile: targetFile.filePath,
            changes: editResult.changes
        }));
        
    } catch (error) {
        log(`[ASR Code Edit] Error: ${error}`);
        await speakTokenList([{ tokens: ['Error during code editing'], category: undefined }]);
        vscode.window.showErrorMessage(`ASR Code Edit Error: ${error}`);
    }
}

/**
 * Step 1: Find target code file using bash script and LLM
 */
async function findTargetCodeFile(instruction: string): Promise<FileSearchResult | null> {
    try {
        // First, get workspace files using bash-like approach
        const workspaceFiles = await getWorkspaceCodeFiles();
        
        // Use LLM to analyze instruction and find most relevant file
        const systemPrompt = `You are a code file finder. Analyze the user's instruction and find the most relevant file from the provided list.

INSTRUCTION ANALYSIS PRIORITY:
1. EXPLICIT FILE NAMES: Look for exact file names mentioned (e.g., "university.py", "server.ts")
2. CLASS/FUNCTION NAMES: Match class or function names with likely file names
3. FEATURE DESCRIPTIONS: Match feature descriptions with file purposes
4. FILE EXTENSIONS: Consider programming language hints

IMPORTANT: 
- If a specific file name is mentioned, prioritize it highly
- If instruction mentions "university" or "University", look for files like "university.py"
- If instruction mentions specific functions/classes, find files likely to contain them
- DO NOT default to currently open files unless explicitly mentioned

RESPONSE FORMAT:
Return a JSON object with:
{
  "filePath": "exact/path/from/list",
  "confidence": 0.95,
  "reason": "Specific explanation of why this file matches"
}

If no suitable file is found, return:
{
  "filePath": null,
  "confidence": 0,
  "reason": "No matching file found in the list"
}`;

        const prompt = `User instruction: "${instruction}"

Available files:
${workspaceFiles.map(f => `- ${f}`).join('\n')}

Analyze the instruction and find the most relevant file. Pay special attention to any file names, class names, or function names mentioned in the instruction.`;

        const response = await callLLMForCompletion(systemPrompt, prompt, 500, 0.1);
        
        try {
            const result = JSON.parse(response);
            if (result.filePath && result.confidence > 0.5) {
                log(`[ASR Code Edit] Found target file: ${result.filePath} (confidence: ${result.confidence})`);
                return result;
            }
        } catch (parseError) {
            log(`[ASR Code Edit] Failed to parse LLM response: ${parseError}`);
        }
        
        // Enhanced fallback: try to match instruction with file names
        const instructionLower = instruction.toLowerCase();
        
        // Look for explicit file mentions in the instruction
        for (const filePath of workspaceFiles) {
            const fileName = path.basename(filePath).toLowerCase();
            const fileNameWithoutExt = path.basename(filePath, path.extname(filePath)).toLowerCase();
            
            // Check if instruction mentions the file name
            if (instructionLower.includes(fileName) || instructionLower.includes(fileNameWithoutExt)) {
                log(`[ASR Code Edit] Found file by name match: ${filePath}`);
                return {
                    filePath,
                    confidence: 0.8,
                    reason: `File name "${fileName}" mentioned in instruction`
                };
            }
        }
        
        // Look for programming language hints and match with file extensions
        const languageHints = {
            'python': ['.py'],
            'typescript': ['.ts'],
            'javascript': ['.js'],
            'java': ['.java'],
            'cpp': ['.cpp', '.c'],
            'csharp': ['.cs'],
            'go': ['.go'],
            'rust': ['.rs']
        };
        
        for (const [lang, extensions] of Object.entries(languageHints)) {
            if (instructionLower.includes(lang)) {
                const matchingFiles = workspaceFiles.filter(f => 
                    extensions.some(ext => f.endsWith(ext))
                );
                if (matchingFiles.length > 0) {
                    // Prefer files with relevant names
                    const relevantFile = matchingFiles.find(f => 
                        instructionLower.split(' ').some(word => 
                            path.basename(f).toLowerCase().includes(word)
                        )
                    ) || matchingFiles[0];
                    
                    log(`[ASR Code Edit] Found file by language hint: ${relevantFile}`);
                    return {
                        filePath: relevantFile,
                        confidence: 0.6,
                        reason: `Matched ${lang} language hint`
                    };
                }
            }
        }
        
        // Last resort: ask user to specify the file
        log(`[ASR Code Edit] Could not determine target file from instruction: "${instruction}"`);
        return null;
    } catch (error) {
        log(`[ASR Code Edit] Error finding target file: ${error}`);
        return null;
    }
}

/**
 * Get workspace code files using bash-like approach
 */
async function getWorkspaceCodeFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return [];
    
    const codeExtensions = ['.ts', '.js', '.py', '.java', '.cpp', '.c', '.cs', '.go', '.rs', '.php', '.rb'];
    const files: string[] = [];
    
    for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        await findCodeFilesRecursive(folderPath, files, codeExtensions);
    }
    
    // Limit to reasonable number of files and prioritize recent/relevant ones
    return files.slice(0, 100);
}

/**
 * Recursively find code files
 */
async function findCodeFilesRecursive(dirPath: string, files: string[], extensions: string[]): Promise<void> {
    try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory()) {
                // Skip common non-code directories
                if (!['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) {
                    await findCodeFilesRecursive(fullPath, files, extensions);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                if (extensions.includes(ext)) {
                    files.push(fullPath);
                }
            }
        }
    } catch (error) {
        // Silently skip directories we can't read
    }
}

/**
 * Step 2: Retrieve file content using cat-like approach
 */
async function retrieveFileContent(filePath: string): Promise<string> {
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        log(`[ASR Code Edit] Retrieved content from ${filePath} (${content.length} characters)`);
        return content;
    } catch (error) {
        throw new Error(`Failed to read file ${filePath}: ${error}`);
    }
}

/**
 * Step 3: Edit code using LLM
 */
async function editCodeWithLLM(content: string, instruction: string, filePath: string): Promise<EditResult> {
    const systemPrompt = `You are an expert code editor. Analyze the provided code and instruction, then return the complete modified file.

IMPORTANT RULES:
1. Return the COMPLETE modified file, not just changes
2. Maintain proper code structure and formatting
3. Preserve existing functionality while adding requested changes
4. Include all necessary imports and dependencies
5. Do not use markdown code fences in your response
6. Make targeted, precise changes based on the instruction

FILE CONTEXT:
- File: ${path.basename(filePath)}
- Language: ${getLanguageFromExtension(path.extname(filePath))}`;

    const prompt = `Original Code:
${content}

Instruction: ${instruction}

Return the complete modified file with the requested changes applied.`;

    const modifiedContent = await callLLMForCompletion(systemPrompt, prompt, 4000, 0.1);
    
    // Calculate changes
    const changes = calculateChanges(content, modifiedContent);
    
    // Generate summary
    const summary = await generateChangeSummary(instruction, changes);
    
    return {
        originalContent: content,
        modifiedContent: modifiedContent.trim(),
        filePath,
        summary,
        changes
    };
}

/**
 * Get programming language from file extension
 */
function getLanguageFromExtension(ext: string): string {
    const langMap: { [key: string]: string } = {
        '.ts': 'TypeScript',
        '.js': 'JavaScript',
        '.py': 'Python',
        '.java': 'Java',
        '.cpp': 'C++',
        '.c': 'C',
        '.cs': 'C#',
        '.go': 'Go',
        '.rs': 'Rust',
        '.php': 'PHP',
        '.rb': 'Ruby'
    };
    return langMap[ext] || 'Unknown';
}

/**
 * Calculate changes between original and modified content
 */
function calculateChanges(original: string, modifiedContent: string): { added: number; removed: number; modified: number } {
    const originalLines = original.split('\n');
    const modifiedLines = modifiedContent.split('\n');
    
    // Simple diff calculation
    const maxLines = Math.max(originalLines.length, modifiedLines.length);
    let added = 0, removed = 0, modifiedCount = 0;
    
    if (modifiedLines.length > originalLines.length) {
        added = modifiedLines.length - originalLines.length;
    } else if (originalLines.length > modifiedLines.length) {
        removed = originalLines.length - modifiedLines.length;
    }
    
    // Count modified lines (simplified)
    const minLines = Math.min(originalLines.length, modifiedLines.length);
    for (let i = 0; i < minLines; i++) {
        if (originalLines[i] !== modifiedLines[i]) {
            modifiedCount++;
        }
    }
    
    return { added, removed, modified: modifiedCount };
}

/**
 * Generate change summary using LLM
 */
async function generateChangeSummary(instruction: string, changes: { added: number; removed: number; modified: number }): Promise<string> {
    const systemPrompt = `Generate a concise summary of code changes in 1-2 sentences.`;
    const prompt = `Instruction: "${instruction}"
Changes: +${changes.added} lines, -${changes.removed} lines, ~${changes.modified} modified lines

Summarize what was changed:`;

    try {
        const summary = await callLLMForCompletion(systemPrompt, prompt, 100, 0.1);
        return summary.trim();
    } catch (error) {
        return `Applied changes: +${changes.added}, -${changes.removed}, ~${changes.modified} lines modified`;
    }
}

/**
 * Step 4: Show diff and save changes
 */
async function showDiffAndSave(editResult: EditResult): Promise<void> {
    try {
        log(`[ASR Code Edit] Creating Copilot-style diff for: ${editResult.filePath}`);
        
        // Open the original file
        const originalUri = vscode.Uri.file(editResult.filePath);
        const document = await vscode.workspace.openTextDocument(originalUri);
        const editor = await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false
        });
        
        // Show Copilot-style inline diff with accept/reject buttons
        const accepted = await showCopilotStyleDiff(editor, editResult);
        
        if (accepted) {
            // Apply the changes to the actual file
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(document.lineCount, 0)
            );
            
            edit.replace(originalUri, fullRange, editResult.modifiedContent);
            
            const success = await vscode.workspace.applyEdit(edit);
            
            if (success) {
                await document.save();
                log(`[ASR Code Edit] ✅ Changes applied and saved to ${editResult.filePath}`);
                
                const changesSummary = `+${editResult.changes.added} -${editResult.changes.removed} ~${editResult.changes.modified}`;
                const fileName = path.basename(editResult.filePath);
                vscode.window.showInformationMessage(
                    `✅ Changes applied to ${fileName}: ${changesSummary}`,
                    { modal: false }
                );
            } else {
                throw new Error(`Failed to apply changes to ${editResult.filePath}`);
            }
        } else {
            log(`[ASR Code Edit] User rejected changes for ${editResult.filePath}`);
            throw new Error('User rejected changes');
        }
        
    } catch (error) {
        log(`[ASR Code Edit] ❌ Error showing Copilot-style diff: ${error}`);
        throw error;
    }
}

/**
 * Step 5: Summarize changes and speak them
 */
async function summarizeAndSpeakChanges(editResult: EditResult): Promise<void> {
    const fileName = path.basename(editResult.filePath);
    const changesSummary = `+${editResult.changes.added} -${editResult.changes.removed} ~${editResult.changes.modified}`;
    
    const spokenSummary = `Changes applied to ${fileName}. ${editResult.summary}. ${changesSummary} lines affected.`;
    
    await speakTokenList([{
        tokens: [spokenSummary],
        category: undefined
    }]);
    
    log(`[ASR Code Edit] Spoken summary: ${spokenSummary}`);
}

// Decoration types for diff display
const addedLineDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(46, 160, 67, 0.2)', // Green background
    isWholeLine: true,
    overviewRulerColor: '#2ea043',
    overviewRulerLane: vscode.OverviewRulerLane.Left
});

const removedLineDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(248, 81, 73, 0.2)', // Red background
    isWholeLine: true,
    overviewRulerColor: '#f85149',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    textDecoration: 'line-through'
});

const modifiedLineDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 193, 7, 0.2)', // Yellow background for modified
    isWholeLine: true,
    overviewRulerColor: '#ffc107',
    overviewRulerLane: vscode.OverviewRulerLane.Left
});

// Global state for managing active diff
let activeDiffEditor: vscode.TextEditor | null = null;
let activeDecorationTypes: vscode.TextEditorDecorationType[] = [];

/**
 * Show proper diff with red/green highlighting and accept/reject buttons
 */
async function showCopilotStyleDiff(editor: vscode.TextEditor, editResult: EditResult): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        // Clear any existing diff
        clearActiveDiff();
        
        // Set active diff editor
        activeDiffEditor = editor;
        
        const originalContent = editResult.originalContent;
        const modifiedContent = editResult.modifiedContent;
        
        // Calculate proper diff using diff library
        const diffResult = calculateProperDiff(originalContent, modifiedContent);
        
        // Create content that shows both added and removed lines
        const displayContent = createDiffDisplayContent(diffResult);
        
        // Show the diff content with highlighting
        editor.edit(editBuilder => {
            const fullRange = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(editor.document.lineCount, 0)
            );
            editBuilder.replace(fullRange, displayContent.content);
        }).then(() => {
            // Apply proper red/green highlighting
            applyProperDiffHighlighting(editor, displayContent);
            
            // Show accept/reject buttons
            showProperAcceptRejectButtons(editResult, originalContent, modifiedContent, resolve);
        });
    });
}

/**
 * Calculate proper diff using diff library
 */
function calculateProperDiff(originalContent: string, modifiedContent: string): diff.Change[] {
    return diff.diffLines(originalContent, modifiedContent);
}

/**
 * Create display content that shows both added and removed lines
 */
function createDiffDisplayContent(diffResult: diff.Change[]): { content: string; lineTypes: ('added' | 'removed' | 'unchanged')[] } {
    const lines: string[] = [];
    const lineTypes: ('added' | 'removed' | 'unchanged')[] = [];
    
    diffResult.forEach(change => {
        if (change.removed) {
            // Show removed lines with "// REMOVED: " prefix
            const removedLines = change.value.split('\n').filter(line => line.length > 0);
            removedLines.forEach(line => {
                lines.push(`// REMOVED: ${line}`);
                lineTypes.push('removed');
            });
        } else if (change.added) {
            // Show added lines normally
            const addedLines = change.value.split('\n').filter(line => line.length > 0);
            addedLines.forEach(line => {
                lines.push(line);
                lineTypes.push('added');
            });
        } else {
            // Show unchanged lines normally
            const unchangedLines = change.value.split('\n').filter(line => line.length > 0);
            unchangedLines.forEach(line => {
                lines.push(line);
                lineTypes.push('unchanged');
            });
        }
    });
    
    return {
        content: lines.join('\n'),
        lineTypes
    };
}

/**
 * Apply proper diff highlighting based on line types
 */
function applyProperDiffHighlighting(editor: vscode.TextEditor, displayContent: { content: string; lineTypes: ('added' | 'removed' | 'unchanged')[] }): void {
    const addedDecorations: vscode.DecorationOptions[] = [];
    const removedDecorations: vscode.DecorationOptions[] = [];
    
    displayContent.lineTypes.forEach((lineType, index) => {
        const range = new vscode.Range(
            new vscode.Position(index, 0),
            new vscode.Position(index, Number.MAX_SAFE_INTEGER)
        );
        
        if (lineType === 'added') {
            addedDecorations.push({ range });
        } else if (lineType === 'removed') {
            removedDecorations.push({ range });
        }
    });
    
    // Apply decorations and track them for cleanup
    editor.setDecorations(addedLineDecorationType, addedDecorations);
    editor.setDecorations(removedLineDecorationType, removedDecorations);
    
    activeDecorationTypes = [addedLineDecorationType, removedLineDecorationType];
}

/**
 * Show accept/reject buttons with proper cleanup
 */
function showProperAcceptRejectButtons(editResult: EditResult, originalContent: string, modifiedContent: string, resolve: (accepted: boolean) => void): void {
    const fileName = path.basename(editResult.filePath);
    const changesSummary = `+${editResult.changes.added} -${editResult.changes.removed}`;
    
    // Show notification with accept/reject buttons
    vscode.window.showInformationMessage(
        `${editResult.summary} (${changesSummary})`,
        '✅ Accept',
        '❌ Reject'
    ).then(choice => {
        if (choice === '✅ Accept') {
            // Apply the final modified content (without diff markers)
            if (activeDiffEditor) {
                activeDiffEditor.edit(editBuilder => {
                    const fullRange = new vscode.Range(
                        new vscode.Position(0, 0),
                        new vscode.Position(activeDiffEditor!.document.lineCount, 0)
                    );
                    editBuilder.replace(fullRange, modifiedContent);
                });
            }
            clearActiveDiff();
            resolve(true);
        } else {
            // Restore original content
            if (activeDiffEditor) {
                activeDiffEditor.edit(editBuilder => {
                    const fullRange = new vscode.Range(
                        new vscode.Position(0, 0),
                        new vscode.Position(activeDiffEditor!.document.lineCount, 0)
                    );
                    editBuilder.replace(fullRange, originalContent);
                });
            }
            clearActiveDiff();
            resolve(false);
        }
    });
}

/**
 * Clear active diff decorations and commands
 */
function clearActiveDiff(): void {
    if (activeDiffEditor && activeDecorationTypes.length > 0) {
        // Clear all active decorations
        activeDecorationTypes.forEach(decorationType => {
            activeDiffEditor!.setDecorations(decorationType, []);
        });
        activeDiffEditor = null;
    }
    
    activeDecorationTypes = [];
}

/**
 * Calculate line-by-line differences between original and modified content
 */
function calculateLineDifferences(original: string, modified: string): DiffLine[] {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');
    const diffLines: DiffLine[] = [];
    
    // Simple line-by-line comparison
    const maxLines = Math.max(originalLines.length, modifiedLines.length);
    
    for (let i = 0; i < maxLines; i++) {
        const originalLine = originalLines[i] || '';
        const modifiedLine = modifiedLines[i] || '';
        
        if (i >= originalLines.length) {
            // New line added
            diffLines.push({
                lineNumber: i,
                type: 'added',
                originalContent: '',
                modifiedContent: modifiedLine
            });
        } else if (i >= modifiedLines.length) {
            // Line removed
            diffLines.push({
                lineNumber: i,
                type: 'removed',
                originalContent: originalLine,
                modifiedContent: ''
            });
        } else if (originalLine !== modifiedLine) {
            // Line modified
            diffLines.push({
                lineNumber: i,
                type: 'modified',
                originalContent: originalLine,
                modifiedContent: modifiedLine
            });
        } else {
            // Line unchanged
            diffLines.push({
                lineNumber: i,
                type: 'unchanged',
                originalContent: originalLine,
                modifiedContent: modifiedLine
            });
        }
    }
    
    return diffLines;
}

/**
 * Create inline diff decorations for VS Code editor
 */
function createInlineDiffDecorations(diffLines: DiffLine[]): {
    addedDecorations: vscode.DecorationOptions[];
    removedDecorations: vscode.DecorationOptions[];
    modifiedDecorations: vscode.DecorationOptions[];
} {
    const addedDecorations: vscode.DecorationOptions[] = [];
    const removedDecorations: vscode.DecorationOptions[] = [];
    const modifiedDecorations: vscode.DecorationOptions[] = [];
    
    diffLines.forEach(diffLine => {
        const range = new vscode.Range(
            new vscode.Position(diffLine.lineNumber, 0),
            new vscode.Position(diffLine.lineNumber, diffLine.originalContent.length)
        );
        
        const decoration: vscode.DecorationOptions = {
            range,
            hoverMessage: `${diffLine.type}: ${diffLine.modifiedContent || diffLine.originalContent}`
        };
        
        switch (diffLine.type) {
            case 'added':
                addedDecorations.push(decoration);
                break;
            case 'removed':
                removedDecorations.push(decoration);
                break;
            case 'modified':
                modifiedDecorations.push(decoration);
                break;
        }
    });
    
    return { addedDecorations, removedDecorations, modifiedDecorations };
}

/**
 * Create inline diff preview content with + and - markers
 */
function createInlineDiffPreview(original: string, modified: string): string {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');
    const previewLines: string[] = [];
    
    previewLines.push('// Changes Preview - Green (+) = Added, Red (-) = Removed, Orange (~) = Modified');
    previewLines.push('');
    
    const maxLines = Math.max(originalLines.length, modifiedLines.length);
    
    for (let i = 0; i < maxLines; i++) {
        const originalLine = originalLines[i];
        const modifiedLine = modifiedLines[i];
        
        if (originalLine === undefined) {
            // Line added
            previewLines.push(`+ ${modifiedLine}`);
        } else if (modifiedLine === undefined) {
            // Line removed
            previewLines.push(`- ${originalLine}`);
        } else if (originalLine !== modifiedLine) {
            // Line modified
            previewLines.push(`- ${originalLine}`);
            previewLines.push(`+ ${modifiedLine}`);
        } else {
            // Line unchanged
            previewLines.push(`  ${originalLine}`);
        }
    }
    
    return previewLines.join('\n');
}

// Interface for diff lines
interface DiffLine {
    lineNumber: number;
    type: 'added' | 'removed' | 'modified' | 'unchanged';
    originalContent: string;
    modifiedContent: string;
}

// Old suggestion function removed - now using intelligent_suggestions.ts

/**
 * Register ASR code editing commands
 */
export function registerASRCodeEditing(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.asrCodeEdit', async (instruction?: string) => {
            if (!instruction) {
                instruction = await vscode.window.showInputBox({
                    placeHolder: 'Enter code editing instruction...',
                    prompt: 'What code changes would you like to make?'
                });
            }
            
            if (instruction) {
                await executeASRCodeEdit(instruction);
            }
        })
    );
    
    // Register cleanup on extension deactivation
    context.subscriptions.push({
        dispose: () => {
            clearActiveDiff();
            addedLineDecorationType.dispose();
            removedLineDecorationType.dispose();
            modifiedLineDecorationType.dispose();
        }
    });
    
    log('[ASR Code Edit] Registered ASR code editing commands');
}
