import * as vscode from 'vscode';
import { speakToken } from '../audio';
import { log } from '../utils';
import * as Diff from 'diff';

interface CodeChange {
    line: number;
    original: string;
    modified: string;
    type: 'added' | 'removed' | 'modified';
}

interface VibeCodingResult {
    changes: CodeChange[];
    summary: string;
    totalAdded: number;
    totalRemoved: number;
    modifiedText: string;
}

interface ContextInfo {
    selectedCode: string;
    focusedFunction: string | null;
    cursorPosition: vscode.Position;
    contextLines: string[];
    isLargeFile: boolean;
}

export async function activateVibeCoding() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        await speakToken('No active editor');
        return;
    }

    // Get intelligent context
    const context = await getIntelligentContext(editor);
    
    // Show input box for natural language instruction
    const instruction = await vscode.window.showInputBox({
        placeHolder: 'Describe what you want to change in the code...',
        prompt: `Vibe Coding: Describe your desired code changes in natural language\n\nContext: ${context.focusedFunction ? 'Function under cursor' : context.selectedCode ? 'Selected code' : 'Entire file'}${context.isLargeFile ? ' (large file)' : ''}`,
        value: '',
        ignoreFocusOut: true
    });

    if (!instruction) {
        await speakToken('No instruction provided');
        return;
    }

    await speakToken('Processing vibe coding request');
    
    try {
        const result = await processVibeCodingRequest(editor, instruction, context);
        await displayVibeCodingResults(result);
    } catch (error) {
        log(`[vibe_coding] Error: ${error}`);
        await speakToken('Error processing vibe coding request');
        vscode.window.showErrorMessage(`Vibe Coding Error: ${error}`);
    }
}

async function getIntelligentContext(editor: vscode.TextEditor): Promise<ContextInfo> {
    const document = editor.document;
    const selection = editor.selection;
    const cursorPosition = editor.selection.active;
    const fullText = document.getText();
    
    // 1. Check for user selection first
    const selectedCode = document.getText(selection);
    if (selectedCode.trim()) {
        log(`[vibe_coding] Using selected code (${selectedCode.length} chars)`);
        return {
            selectedCode,
            focusedFunction: null,
            cursorPosition,
            contextLines: selectedCode.split('\n'),
            isLargeFile: false
        };
    }
    
    // 2. Try to find function under cursor using regex
    const focusedFunction = findFunctionUnderCursor(fullText, cursorPosition.line);
    
    // 3. Use AST analysis to get more context if needed
    const astContext = await getASTContext(document, cursorPosition);
    
    // 4. Determine if this is a large file
    const isLargeFile = fullText.split('\n').length > 500;
    
    let contextLines: string[];
    if (focusedFunction) {
        log(`[vibe_coding] Found function under cursor: ${focusedFunction.substring(0, 100)}...`);
        contextLines = focusedFunction.split('\n');
    } else if (astContext) {
        log(`[vibe_coding] Using AST context`);
        contextLines = astContext.split('\n');
    } else {
        log(`[vibe_coding] Using full file context`);
        contextLines = fullText.split('\n');
    }
    
    return {
        selectedCode: '',
        focusedFunction,
        cursorPosition,
        contextLines,
        isLargeFile
    };
}

function findFunctionUnderCursor(fullText: string, cursorLine: number): string | null {
    const lines = fullText.split('\n');
    
    // Look for function definitions near the cursor
    const functionPatterns = [
        /^def\s+\w+\s*\(/,           // Python functions
        /^async\s+def\s+\w+\s*\(/,    // Python async functions
        /^class\s+\w+/,               // Python classes
        /^function\s+\w+\s*\(/,       // JavaScript functions
        /^const\s+\w+\s*=\s*\(/,      // JavaScript arrow functions
        /^let\s+\w+\s*=\s*\(/,        // JavaScript arrow functions
        /^var\s+\w+\s*=\s*\(/,        // JavaScript arrow functions
        /^public\s+.*\s+\w+\s*\(/,    // Java/C# methods
        /^private\s+.*\s+\w+\s*\(/,   // Java/C# methods
        /^protected\s+.*\s+\w+\s*\(/, // Java/C# methods
    ];
    
    // Search backwards from cursor to find the most recent function
    for (let i = cursorLine; i >= 0; i--) {
        const line = lines[i];
        for (const pattern of functionPatterns) {
            if (pattern.test(line)) {
                // Found a function definition, extract the function
                return extractFunction(lines, i);
            }
        }
    }
    
    return null;
}

function extractFunction(lines: string[], startLine: number): string {
    const functionLines: string[] = [];
    let braceCount = 0;
    let parenCount = 0;
    let inFunction = false;
    
    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];
        functionLines.push(line);
        
        // Count braces and parentheses to find function end
        for (const char of line) {
            if (char === '{') braceCount++;
            if (char === '}') braceCount--;
            if (char === '(') parenCount++;
            if (char === ')') parenCount--;
        }
        
        // For Python, look for indentation level
        if (lines[startLine].startsWith('def ') || lines[startLine].startsWith('class ')) {
            const baseIndent = lines[startLine].match(/^\s*/)?.[0].length || 0;
            const currentIndent = line.match(/^\s*/)?.[0].length || 0;
            
            // If we're back to the base indentation level and not at the start
            if (i > startLine && currentIndent <= baseIndent && line.trim() !== '') {
                functionLines.pop(); // Remove the last line as it's outside the function
                break;
            }
        } else {
            // For other languages, use brace counting
            if (braceCount === 0 && parenCount === 0 && i > startLine) {
                break;
            }
        }
    }
    
    return functionLines.join('\n');
}

async function getASTContext(document: vscode.TextDocument, cursorPosition: vscode.Position): Promise<string | null> {
    try {
        // Get the symbol at the cursor position
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );
        
        if (!symbols || symbols.length === 0) {
            return null;
        }
        
        // Find the symbol that contains the cursor position
        const cursorOffset = document.offsetAt(cursorPosition);
        let targetSymbol: vscode.SymbolInformation | null = null;
        
        for (const symbol of symbols) {
            const symbolRange = symbol.location.range;
            const symbolStart = document.offsetAt(symbolRange.start);
            const symbolEnd = document.offsetAt(symbolRange.end);
            
            if (cursorOffset >= symbolStart && cursorOffset <= symbolEnd) {
                targetSymbol = symbol;
                break;
            }
        }
        
        if (targetSymbol) {
            // Extract the code for this symbol
            const symbolRange = targetSymbol.location.range;
            const symbolCode = document.getText(symbolRange);
            log(`[vibe_coding] Found AST symbol: ${targetSymbol.name} (${symbolCode.length} chars)`);
            return symbolCode;
        }
        
        return null;
    } catch (error) {
        log(`[vibe_coding] AST analysis failed: ${error}`);
        return null;
    }
}

async function processVibeCodingRequest(
    editor: vscode.TextEditor, 
    instruction: string,
    context: ContextInfo
): Promise<VibeCodingResult> {
    const document = editor.document;
    const originalText = document.getText();
    
    // Use the intelligent context
    const contextText = context.selectedCode || context.focusedFunction || context.contextLines.join('\n');
    
    // Determine the type of request and handle it appropriately
    const requestType = analyzeRequestType(instruction);
    
    let modifiedCode: string;
    
    if (requestType === 'add_test' && context.focusedFunction) {
        // For test requests, append to the end of the file
        modifiedCode = await handleAddTestRequest(originalText, contextText, instruction);
    } else if (requestType === 'modify_function' && context.focusedFunction) {
        // For function modifications, replace the specific function
        modifiedCode = await handleModifyFunctionRequest(originalText, context.focusedFunction, instruction);
    } else if (requestType === 'add_function') {
        // For new functions, add at the end or in appropriate location
        modifiedCode = await handleAddFunctionRequest(originalText, instruction);
    } else {
        // Fallback to the original diff approach
        const prompt = createVibeCodingPrompt(contextText, instruction, context);
        const diff = await callLLMForCodeModification(prompt);
        modifiedCode = applyUnifiedDiff(originalText, diff);
    }
    
    // Calculate differences
    const changes = calculateCodeChanges(originalText, modifiedCode, editor.selection);
    
    // Generate summary
    const summary = await generateChangeSummary(instruction, changes, context);
    
    const totalAdded = changes.filter(c => c.type === 'added').length;
    const totalRemoved = changes.filter(c => c.type === 'removed').length;
    
    return {
        changes,
        summary,
        totalAdded,
        totalRemoved,
        modifiedText: modifiedCode
    };
}

function analyzeRequestType(instruction: string): 'add_test' | 'modify_function' | 'add_function' | 'general' {
    const lowerInstruction = instruction.toLowerCase();
    
    if (lowerInstruction.includes('test') || lowerInstruction.includes('unit test') || lowerInstruction.includes('assert')) {
        return 'add_test';
    } else if (lowerInstruction.includes('modify') || lowerInstruction.includes('improve') || lowerInstruction.includes('fix') || lowerInstruction.includes('update')) {
        return 'modify_function';
    } else if (lowerInstruction.includes('add function') || lowerInstruction.includes('create function') || lowerInstruction.includes('new function')) {
        return 'add_function';
    }
    
    return 'general';
}

async function handleAddTestRequest(originalText: string, contextText: string, instruction: string): Promise<string> {
    const prompt = `You are a helpful coding assistant. The user wants to add test code for this function:

${contextText}

Please generate a test function for this code. The test should:
- Be comprehensive and test edge cases
- Use the same language and testing framework as the original code
- Be placed at the end of the file
- Follow the same coding style and conventions

Return ONLY the test function code, no explanations or markdown formatting.`;

    const testCode = await callLLMForCodeModification(prompt);
    const cleanTestCode = stripCodeFences(testCode);
    
    // Append the test code to the end of the file
    return originalText + '\n\n' + cleanTestCode;
}

async function handleModifyFunctionRequest(originalText: string, functionCode: string, instruction: string): Promise<string> {
    const prompt = `You are a helpful coding assistant. The user wants to modify this function:

${functionCode}

Modification request: "${instruction}"

Please provide the modified function. Return ONLY the modified function code, no explanations or markdown formatting.`;

    const modifiedFunctionCode = await callLLMForCodeModification(prompt);
    const cleanModifiedFunction = stripCodeFences(modifiedFunctionCode);
    
    // Replace the original function with the modified one
    return originalText.replace(functionCode, cleanModifiedFunction);
}

async function handleAddFunctionRequest(originalText: string, instruction: string): Promise<string> {
    const prompt = `You are a helpful coding assistant. The user wants to add a new function to this code:

${originalText}

Request: "${instruction}"

Please generate the new function. Return ONLY the function code, no explanations or markdown formatting.`;

    const newFunctionCode = await callLLMForCodeModification(prompt);
    const cleanNewFunction = stripCodeFences(newFunctionCode);
    
    // Add the new function at the end of the file
    return originalText + '\n\n' + cleanNewFunction;
}

function createVibeCodingPrompt(contextCode: string, instruction: string, context: ContextInfo): string {
    let prompt = `You are a helpful coding assistant. The user wants to modify their code based on this instruction: "${instruction}"

`;
    
    if (context.focusedFunction) {
        prompt += `FOCUS: The user is working on this specific function (the cursor is positioned here):
\`\`\`
${context.focusedFunction}
\`\`\`

`;
    } else if (context.selectedCode) {
        prompt += `SELECTED CODE: The user has selected this code to modify:
\`\`\`
${context.selectedCode}
\`\`\`

`;
    }
    
    prompt += `CONTEXT: Here is the relevant code context:
\`\`\`
${contextCode}
\`\`\`

Please provide a unified diff (patch) that implements the requested changes. The diff must start with "---" and "+++" lines. 

IMPORTANT INSTRUCTIONS:
- If the user asks to "add test code", append the test at the end of the file
- If the user asks to "modify" or "improve" a function, modify that specific function
- If the user asks to "add" something, place it in the most appropriate location
- Use the same coding style and conventions as the existing code
- Do not include any explanations, markdown formatting, or code fences
- Only output the unified diff

If the instruction is unclear or impossible to implement, return an empty diff.

Example format:
--- original
+++ modified
@@ -10,6 +10,15 @@
 unchanged line
-removed line
+added line
 unchanged line`;
    
    return prompt;
}

async function callLLMForCodeModification(prompt: string): Promise<string> {
    try {
        const { getOpenAIClient } = await import('../llm.js');
        const client = getOpenAIClient();
        
        log(`[vibe_coding] Sending prompt to OpenAI: ${prompt.substring(0, 200)}...`);
        
        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: "You are a helpful coding assistant. When asked to modify code, return ONLY a unified diff (patch) for the requested changes. Do not include any explanations, markdown formatting, or code fences. If the request is unclear or impossible to implement, return an empty diff." 
                },
                { role: "user", content: prompt }
            ],
            max_tokens: 2000,
            temperature: 0.1
        });
        
        const diff = response.choices[0]?.message?.content?.trim() || '';
        log(`[vibe_coding] Received diff from OpenAI: ${diff.substring(0, 200)}...`);
        
        return diff;
    } catch (error) {
        log(`[vibe_coding] LLM error: ${error}`);
        throw new Error(`Failed to get code modification from LLM: ${error}`);
    }
}

function stripCodeFences(diff: string): string {
    // Remove ```diff or ``` and ending ```
    return diff.replace(/^```(?:diff)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function convertFileDiffToContentDiff(diff: string): string {
    // Remove file path headers (--- a/file.py, +++ b/file.py) and convert to content-based diff
    return diff
        .replace(/^---\s+a\/.*$/m, '--- original')
        .replace(/^\+\+\+\s+b\/.*$/m, '+++ modified');
}

function applyUnifiedDiff(originalText: string, diff: string): string {
    if (!diff.trim()) {
        log(`[vibe_coding] Empty diff received`);
        return originalText;
    }
    
    try {
        const cleanDiff = stripCodeFences(diff);
        log(`[vibe_coding] Cleaned diff: ${cleanDiff.substring(0, 200)}...`);
        
        // Check if the diff starts with the expected format
        if (!cleanDiff.startsWith('---')) {
            log(`[vibe_coding] Diff does not start with "---", format may be incorrect`);
            log(`[vibe_coding] Diff starts with: ${cleanDiff.substring(0, 50)}`);
            return originalText;
        }
        
        // Convert file-based diff to content-based diff
        const contentDiff = convertFileDiffToContentDiff(cleanDiff);
        log(`[vibe_coding] Converted to content diff: ${contentDiff.substring(0, 200)}...`);
        
        const patched = Diff.applyPatch(originalText, contentDiff);
        if (patched === false) {
            log(`[vibe_coding] Patch failed to apply, trying manual fallback`);
            return applyManualChanges(originalText, contentDiff);
        }
        
        log(`[vibe_coding] Patch applied successfully`);
        return patched;
    } catch (e) {
        log(`[vibe_coding] Error applying patch: ${e}`);
        return originalText;
    }
}

function applyManualChanges(originalText: string, diff: string): string {
    try {
        log(`[vibe_coding] Attempting manual change application`);
        
        // Parse the diff manually
        const lines = originalText.split('\n');
        const diffLines = diff.split('\n');
        
        // Find the @@ line to get the line numbers
        const atAtLine = diffLines.find(line => line.startsWith('@@'));
        if (!atAtLine) {
            log(`[vibe_coding] No @@ line found in diff`);
            return originalText;
        }
        
        // Parse @@ -oldStart,oldCount +newStart,newCount @@
        const match = atAtLine.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
        if (!match) {
            log(`[vibe_coding] Could not parse @@ line: ${atAtLine}`);
            return originalText;
        }
        
        const oldStart = parseInt(match[1]) - 1; // Convert to 0-based
        const oldCount = parseInt(match[2]);
        const newStart = parseInt(match[3]) - 1; // Convert to 0-based
        const newCount = parseInt(match[4]);
        
        log(`[vibe_coding] Parsed diff: oldStart=${oldStart}, oldCount=${oldCount}, newStart=${newStart}, newCount=${newCount}`);
        
        // Find the context lines in the diff
        const contextLines = [];
        let i = diffLines.indexOf(atAtLine) + 1;
        while (i < diffLines.length && !diffLines[i].startsWith('@@')) {
            if (diffLines[i].startsWith(' ') || diffLines[i].startsWith('+') || diffLines[i].startsWith('-')) {
                contextLines.push(diffLines[i]);
            }
            i++;
        }
        
        log(`[vibe_coding] Found ${contextLines.length} context lines`);
        
        // Apply the changes manually
        const newLines = [...lines];
        
        // Remove the old lines
        newLines.splice(oldStart, oldCount);
        
        // Add the new lines
        const newContent = contextLines
            .filter(line => line.startsWith('+'))
            .map(line => line.substring(1));
        
        newLines.splice(oldStart, 0, ...newContent);
        
        log(`[vibe_coding] Manual change applied successfully`);
        return newLines.join('\n');
        
    } catch (e) {
        log(`[vibe_coding] Manual change failed: ${e}`);
        return originalText;
    }
}

function calculateCodeChanges(
    originalText: string, 
    modifiedText: string, 
    selection: vscode.Selection
): CodeChange[] {
    const originalLines = originalText.split('\n');
    const modifiedLines = modifiedText.split('\n');
    const changes: CodeChange[] = [];
    
    // Use a more sophisticated diff algorithm
    const maxLines = Math.max(originalLines.length, modifiedLines.length);
    let originalIndex = 0;
    let modifiedIndex = 0;
    
    while (originalIndex < originalLines.length || modifiedIndex < modifiedLines.length) {
        const originalLine = originalLines[originalIndex] || '';
        const modifiedLine = modifiedLines[modifiedIndex] || '';
        
        if (originalLine === modifiedLine) {
            // Lines are identical, move both pointers
            originalIndex++;
            modifiedIndex++;
        } else {
            // Check if this is an addition
            if (originalIndex < originalLines.length && 
                modifiedIndex + 1 < modifiedLines.length && 
                originalLines[originalIndex] === modifiedLines[modifiedIndex + 1]) {
                // This is an addition
                changes.push({
                    line: modifiedIndex + 1,
                    original: '',
                    modified: modifiedLine,
                    type: 'added'
                });
                modifiedIndex++;
            } else if (modifiedIndex < modifiedLines.length && 
                       originalIndex + 1 < originalLines.length && 
                       originalLines[originalIndex + 1] === modifiedLines[modifiedIndex]) {
                // This is a deletion
                changes.push({
                    line: originalIndex + 1,
                    original: originalLine,
                    modified: '',
                    type: 'removed'
                });
                originalIndex++;
            } else {
                // This is a modification
                changes.push({
                    line: originalIndex + 1,
                    original: originalLine,
                    modified: modifiedLine,
                    type: 'modified'
                });
                originalIndex++;
                modifiedIndex++;
            }
        }
    }
    
    return changes;
}

async function generateChangeSummary(instruction: string, changes: CodeChange[], context: ContextInfo): Promise<string> {
    const totalAdded = changes.filter(c => c.type === 'added').length;
    const totalRemoved = changes.filter(c => c.type === 'removed').length;
    const totalModified = changes.filter(c => c.type === 'modified').length;
    
    let summary = `Based on your request "${instruction}", I made the following changes:\n\n`;
    
    // Add context information
    if (context.focusedFunction) {
        summary += `📌 Focus: Function under cursor\n`;
    } else if (context.selectedCode) {
        summary += `📌 Focus: Selected code (${context.selectedCode.length} chars)\n`;
    } else {
        summary += `📌 Focus: Entire file${context.isLargeFile ? ' (large file)' : ''}\n`;
    }
    
    summary += '\n';
    
    if (totalAdded > 0) {
        summary += `• Added ${totalAdded} new line${totalAdded > 1 ? 's' : ''}\n`;
    }
    if (totalRemoved > 0) {
        summary += `• Removed ${totalRemoved} line${totalRemoved > 1 ? 's' : ''}\n`;
    }
    if (totalModified > 0) {
        summary += `• Modified ${totalModified} line${totalModified > 1 ? 's' : ''}\n`;
    }
    
    if (changes.length === 0) {
        summary += `• No changes were made\n`;
    }
    
    summary += `\nLine changes: +${totalAdded}, -${totalRemoved}`;
    
    return summary;
}

async function displayVibeCodingResults(result: VibeCodingResult) {
    const { changes, summary, totalAdded, totalRemoved } = result;
    
    if (changes.length === 0) {
        await speakToken('No changes were made');
        vscode.window.showInformationMessage('No changes were made to the code.');
        return;
    }
    
    // Show the summary in a popup
    const action = await vscode.window.showInformationMessage(
        summary,
        'Apply Changes',
        'Cancel'
    );
    
    if (action === 'Apply Changes') {
        await applyCodeChanges(result);
        await speakToken(`Applied ${totalAdded} additions and ${totalRemoved} removals`);
    } else {
        await speakToken('Changes cancelled');
    }
}

async function applyCodeChanges(result: VibeCodingResult) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    
    // Instead of applying individual changes, replace the entire document content
    // This prevents line number inconsistencies that cause the "Illegal value for line" error
    const document = editor.document;
    const originalText = document.getText();
    
    // Get the modified text from the result
    const modifiedText = result.modifiedText;
    
    // Replace the entire document content
    await editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(originalText.length)
        );
        editBuilder.replace(fullRange, modifiedText);
    });
}

// Register the command
export function registerVibeCodingCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.vibeCoding', activateVibeCoding)
    );
} 