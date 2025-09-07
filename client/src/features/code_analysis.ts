import * as vscode from 'vscode';
import { speakGPT } from '../audio';
import { log, logError, logSuccess } from '../utils';
import { getOpenAIClient } from '../llm';

interface CodeAnalysisResult {
    question: string;
    answer: string;
    details?: string;
    statistics?: {
        functions: number;
        variables: number;
        classes: number;
        lines: number;
    };
}

interface CodeContext {
    fileName: string;
    language: string;
    selectedText: string;
    fullText: string;
    cursorPosition: vscode.Position;
    currentFunction?: string;
}

/**
 * Main function to analyze code based on natural language questions
 */
export async function analyzeCodeWithQuestion(question: string): Promise<void> {
    log(`[CodeAnalysis] 🚀 ANALYZE CODE WITH QUESTION CALLED: "${question}"`);
    
    const { isEditorActive } = require('../ide/active');
    const editor = isEditorActive();
    if (!editor) {
        log(`[CodeAnalysis] 🚀 No active editor found`);
        await showAndSpeakResult({
            question,
            answer: "No active editor found. Please open a code file first."
        });
        return;
    }

    try {
        log(`[CodeAnalysis] 🚀 Analyzing question: "${question}"`);
        
        // Get code context
        const context = await getCodeContext(editor);
        log(`[CodeAnalysis] 🚀 Got context for file: ${context.fileName}`);
        
        // Analyze the question and generate response
        const result = await analyzeCodeQuestion(question, context);
        log(`[CodeAnalysis] 🚀 Got analysis result: "${result.answer}"`);
        
        // Show and speak the result
        await showAndSpeakResult(result);
        
    } catch (error) {
        logError(`[CodeAnalysis] 🚨 Error analyzing code: ${error}`);
        await showAndSpeakResult({
            question,
            answer: `Sorry, I encountered an error while analyzing the code: ${error}`
        });
    }
}

/**
 * Get comprehensive code context from the current editor with smart context selection
 */
async function getCodeContext(editor: vscode.TextEditor): Promise<CodeContext> {
    const document = editor.document;
    const selection = editor.selection;
    const position = editor.selection.active;
    
    // Get full text for small files, focused context for large files
    const fullText = document.getText();
    const isLargeFile = fullText.length > 10000; // 10KB threshold
    
    let contextText = fullText;
    if (isLargeFile) {
        // For large files, provide focused context around cursor position
        const contextRadius = 50; // lines before and after cursor
        const startLine = Math.max(0, position.line - contextRadius);
        const endLine = Math.min(document.lineCount - 1, position.line + contextRadius);
        const contextRange = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
        contextText = document.getText(contextRange);
        
        log(`[CodeAnalysis] Large file detected (${fullText.length} chars), using focused context: lines ${startLine + 1}-${endLine + 1}`);
    }
    
    const context: CodeContext = {
        fileName: document.fileName,
        language: document.languageId,
        selectedText: document.getText(selection),
        fullText: contextText, // Use focused context for large files
        cursorPosition: position
    };
    
    // Try to get current function name and details
    try {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );
        
        if (symbols) {
            const currentFunction = findCurrentFunction(symbols, position);
            if (currentFunction) {
                context.currentFunction = currentFunction.name;
                log(`[CodeAnalysis] Found current function: ${currentFunction.name} at line ${currentFunction.range.start.line + 1}`);
            } else {
                log(`[CodeAnalysis] No current function found at cursor position line ${position.line + 1}`);
            }
        }
    } catch (error) {
        log(`[CodeAnalysis] Could not get symbols: ${error}`);
    }
    
    return context;
}

/**
 * Find the function that contains the current cursor position
 */
function findCurrentFunction(symbols: vscode.DocumentSymbol[], position: vscode.Position): vscode.DocumentSymbol | null {
    for (const symbol of symbols) {
        if (symbol.kind === vscode.SymbolKind.Function || symbol.kind === vscode.SymbolKind.Method) {
            if (position.isAfterOrEqual(symbol.range.start) && position.isBeforeOrEqual(symbol.range.end)) {
                return symbol;
            }
        }
        
        // Check nested symbols
        if (symbol.children) {
            const nestedFunction = findCurrentFunction(symbol.children, position);
            if (nestedFunction) {
                return nestedFunction;
            }
        }
    }
    return null;
}

/**
 * Analyze the code question using LLM
 */
async function analyzeCodeQuestion(question: string, context: CodeContext): Promise<CodeAnalysisResult> {
    const client = getOpenAIClient();
    
    // Determine scope: whole-file overview vs function/section-specific
    const isFunctionSpecific = (
        /함수|function|메서드|method/i.test(question) &&
        (/뭐하는|무엇을|설명|역할|이 부분|이 함수|current function|this function|focused/i.test(question))
    ) || (!!context.currentFunction && /지금 내가 있는 함수|현재 함수/i.test(question));

    const isWholeFileOverview = /이 코드가 뭐하는 코드야|what does this code do|explain this code|코드 설명/i.test(question);

    // Collect function symbols from current file for targeted selection
    let functionNames: string[] = [];
    let targetFunctionName: string | null = null;
    let targetFunctionRange: vscode.Range | null = null;

    try {
        const document = vscode.window.activeTextEditor?.document;
        if (document) {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );
            if (symbols) {
                const allFunctions: vscode.DocumentSymbol[] = [];
                const collect = (nodes: vscode.DocumentSymbol[]) => {
                    for (const n of nodes) {
                        if (n.kind === vscode.SymbolKind.Function || n.kind === vscode.SymbolKind.Method) {
                            allFunctions.push(n);
                        }
                        if (n.children && n.children.length) collect(n.children);
                    }
                };
                collect(symbols);
                functionNames = allFunctions.map(f => f.name);

                // Try to detect ASCII-like function mention in the question and match
                const asciiCandidates = (question.match(/[A-Za-z_][A-Za-z0-9_]{1,60}/g) || [])
                    .map(s => s.toLowerCase());
                if (asciiCandidates.length > 0) {
                    const normalized = (s: string) => s.toLowerCase();
                    const byScore = allFunctions
                        .map(fn => {
                            const name = normalized(fn.name);
                            let score = 0;
                            for (const c of asciiCandidates) {
                                if (name === c) score += 100;
                                else if (name.includes(c)) score += Math.min(90, c.length);
                            }
                            return { fn, score };
                        })
                        .sort((a, b) => b.score - a.score);
                    if (byScore.length > 0 && byScore[0].score > 0) {
                        targetFunctionName = byScore[0].fn.name;
                        targetFunctionRange = new vscode.Range(byScore[0].fn.range.start, byScore[0].fn.range.end);
                    }
                }
            }
        }
    } catch {}

    // Select analysis target text
    let analysisText = context.fullText;
    let analysisScopeNote = 'full file';
    if (targetFunctionRange) {
        const document = vscode.window.activeTextEditor?.document;
        if (document) {
            analysisText = document.getText(targetFunctionRange);
            analysisScopeNote = `function ${targetFunctionName}`;
        }
    } else if (isFunctionSpecific && context.currentFunction) {
        // Try to extract just the current function block for focused analysis
        try {
            const document = vscode.window.activeTextEditor?.document;
            if (document) {
                const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    document.uri
                );
                const func = symbols ? findCurrentFunction(symbols, context.cursorPosition) : null;
                if (func) {
                    const range = new vscode.Range(func.range.start, func.range.end);
                    analysisText = document.getText(range);
                    analysisScopeNote = `function ${func.name}`;
                }
            }
        } catch {}
    } else if (context.selectedText && context.selectedText.trim().length > 0) {
        // If user highlighted a section, focus on that
        analysisText = context.selectedText;
        analysisScopeNote = 'selected section';
    }

    // Create a comprehensive prompt for code analysis with scoped behavior
    const prompt = `You are a code analysis assistant that answers questions about code in both English and Korean.

Question: "${question}"

Code Context:
- File: ${context.fileName}
- Language: ${context.language}
- Current function: ${context.currentFunction || 'Not in a function'}
- Selected text: ${context.selectedText ? 'Provided' : 'None'}
- Analysis scope: ${analysisScopeNote}
- Available functions (names only, from this file): ${functionNames.length > 0 ? functionNames.join(', ') : 'None detected'}

Code to analyze:
\`\`\`${context.language}
${analysisText}
\`\`\`

Answer the question with the following behavior:
- If the user asks a general question like "이 코드가 뭐하는 코드야?" or "what does this code do?": provide a friendly whole-file overview (high level purpose, main components, key functions/classes, data flow) in 6-10 lines max.
- If the user asks about a specific function/section (e.g., mentions 함수/이 부분/this function/current function): explain ONLY that scope (purpose, inputs, outputs, side effects, key steps) in 6-10 lines max.
- Prefer Korean if the question is in Korean; otherwise reply in the question's language.

When the question appears to refer to a function by description (e.g., Korean words describing a function like "하이드 커서 함수"), choose the single most relevant function name from the "Available functions" list above and focus ONLY on that function. Do not guess functions that are not in the provided list.

Common question types include:
- Code state/status questions (지금 코드가 어떤 상태야?)
- Function explanations (어떤 함수에 대해 설명해줘, 지금 내가 있는 함수는 뭐하는 함수야?)
- Variable counts (지금 전역변수가 몇개야?)
- Code structure questions
- Bug detection
- Code quality assessment

Special handling for Korean function analysis questions:
- When asked "지금 내가 있는 함수는 뭐하는 함수야?" or similar, focus on the current function's purpose, parameters, return value, side-effects, and main logic only.

IMPORTANT: Keep your answer concise (max 10 lines). Use bullet-like short sentences or compact paragraphs. Avoid implementation-heavy details unless directly asked. Use the same language as the question.

Response format:
{
  "answer": "Direct, concise answer (max 10 lines)",
  "details": "Additional details if needed (optional, keep brief)",
  "statistics": {
    "functions": number_of_functions,
    "variables": number_of_global_variables,
    "classes": number_of_classes,
    "lines": number_of_lines
  }
}

Respond with valid JSON only.`;

    try {
        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1000,
            temperature: 0.1
        });

        const result = response.choices[0]?.message?.content?.trim();
        if (!result) {
            throw new Error('No response from LLM');
        }

        // Parse JSON response
        let jsonString = result;
        if (result.startsWith('```json') && result.endsWith('```')) {
            jsonString = result.slice(7, -3).trim();
        } else if (result.startsWith('```') && result.endsWith('```')) {
            jsonString = result.slice(3, -3).trim();
        }

        const parsedResult = JSON.parse(jsonString);
        
        return {
            question,
            answer: parsedResult.answer,
            details: parsedResult.details,
            statistics: parsedResult.statistics
        };

    } catch (error) {
        logError(`[CodeAnalysis] LLM analysis failed: ${error}`);
        
        // Fallback to basic analysis
        return await performBasicAnalysis(question, context);
    }
}

/**
 * Fallback basic analysis when LLM fails
 */
async function performBasicAnalysis(question: string, context: CodeContext): Promise<CodeAnalysisResult> {
    const { fullText, language, currentFunction, selectedText } = context;
    const lines = fullText.split('\n');
    
    // Basic statistics
    const functionMatches = fullText.match(/function\s+\w+|def\s+\w+|const\s+\w+\s*=/g) || [];
    const variableMatches = fullText.match(/var\s+\w+|let\s+\w+|const\s+\w+/g) || [];
    const classMatches = fullText.match(/class\s+\w+/g) || [];
    
    const statistics = {
        functions: functionMatches.length,
        variables: variableMatches.length,
        classes: classMatches.length,
        lines: lines.length
    };
    
    // Scope: whole-file vs function/selection only
    const asksWholeFile = /이 코드가 뭐하는 코드야|what does this code do|explain this code|코드 설명/i.test(question);
    const asksFunction = /함수|function|메서드|method|현재 함수|지금 내가 있는 함수/i.test(question);

    // Generate basic answer based on question type and scope
    let answer = '';
    
    if (question.includes('상태') || question.includes('state')) {
        answer = `현재 ${language} 파일은 ${statistics.lines}줄이며, ${statistics.functions}개의 함수와 ${statistics.classes}개의 클래스를 포함하고 있습니다.`;
    } else if (asksFunction) {
        if (currentFunction) {
            if (question.includes('뭐하는') || question.includes('무엇을') || question.includes('어떤')) {
                // Try to extract function code for better analysis
                const functionLines = fullText.split('\n');
                let functionCode = '';
                let inFunction = false;
                let braceCount = 0;
                
                for (const line of functionLines) {
                    if (line.includes(currentFunction) && (line.includes('def ') || line.includes('function ') || line.includes('const ') || line.includes('async '))) {
                        inFunction = true;
                        functionCode += line + '\n';
                        if (line.includes('{')) {
                            braceCount++;
                        }
                        continue;
                    }
                    
                    if (inFunction) {
                        functionCode += line + '\n';
                        braceCount += (line.match(/\{/g) || []).length;
                        braceCount -= (line.match(/\}/g) || []).length;
                        
                        if (braceCount <= 0 && line.trim() !== '') {
                            break;
                        }
                    }
                }
                
                // Provide concise function-only description
                answer = `현재 ${currentFunction} 함수 설명: 입력과 반환, 주요 단계 중심으로 동작합니다. 파일 전체 맥락은 생략하고 함수의 역할에만 집중합니다. (함수 수: ${statistics.functions})`;
            } else {
                answer = `현재 ${currentFunction} 함수 안에 있습니다. 전체 파일에는 ${statistics.functions}개의 함수가 있습니다.`;
            }
        } else {
            answer = `현재 함수 밖에 있습니다. 전체 파일에는 ${statistics.functions}개의 함수가 있습니다.`;
        }
    } else if (question.includes('변수') || question.includes('variable')) {
        answer = `전체 파일에 약 ${statistics.variables}개의 변수 선언이 있습니다.`;
    } else {
        if (asksWholeFile || !selectedText) {
            // Whole-file high-level overview
            answer = `${language} 파일 개요: ${statistics.lines}줄, 함수 ${statistics.functions}개, 클래스 ${statistics.classes}개, 변수 ${statistics.variables}개. 주요 구성요소와 흐름을 중심으로 동작합니다.`;
        } else {
            // Selection-only brief
            answer = `선택된 코드 요약: 핵심 목적과 흐름을 간단히 보여줍니다. 파일 전체 설명은 생략합니다.`;
        }
    }
    
    return {
        question,
        answer,
        statistics
    };
}

/**
 * Show result in status bar and speak it (non-intrusive bottom-right notification)
 */
async function showAndSpeakResult(result: CodeAnalysisResult): Promise<void> {
    const { question, answer, details, statistics } = result;
    
    log(`[CodeAnalysis] 📋 SHOW AND SPEAK RESULT CALLED`);
    log(`[CodeAnalysis] 📋 Question: "${question}"`);
    log(`[CodeAnalysis] 📋 Answer: "${answer}"`);
    
    // Prepare display message for status bar (keep it concise)
    let displayMessage = answer;
    if (statistics) {
        displayMessage += ` (함수 ${statistics.functions}개, 변수 ${statistics.variables}개, 클래스 ${statistics.classes}개, ${statistics.lines}줄)`;
    }
    
    // Show non-intrusive status bar message (appears at bottom-right)
    log(`[CodeAnalysis] 📋 Showing status bar message: "${displayMessage}"`);
    vscode.window.setStatusBarMessage(`💬 ${displayMessage}`, 8000); // Show for 8 seconds
    
    // Always show a non-blocking notification for code analysis results
    // This ensures the user gets visual feedback without intrusive quickpicks
    const fullMessage = details ? `${answer}\n\n${details}` : answer;
    log(`[CodeAnalysis] 📋 Showing information message: "${fullMessage}"`);
    vscode.window.showInformationMessage(fullMessage, { modal: false });
    
    // Speak the answer as plain text
    log(`[CodeAnalysis] 📋 About to call speakAnalysisResult...`);
    await speakAnalysisResult(answer);
    
    logSuccess(`[CodeAnalysis] Analysis completed for: "${question}"`);
}

// Track if code analysis TTS is currently active
let codeAnalysisTTSActive = false;

/**
 * Stop code analysis TTS if active
 */
export function stopCodeAnalysisTTS(): void {
    if (codeAnalysisTTSActive) {
        log('[CodeAnalysis] Stopping code analysis TTS - Command+. pressed');
        codeAnalysisTTSActive = false;
        
        // Stop GPT TTS directly
        try {
            const { stopGPTTTS } = require('../audio');
            stopGPTTTS();
            log('[CodeAnalysis] GPT TTS stopped successfully');
        } catch (error) {
            log(`[CodeAnalysis] Error stopping GPT TTS: ${error}`);
        }
    }
}

/**
 * Convert analysis result to speech using simple TTS approach
 */
async function speakAnalysisResult(answer: string): Promise<void> {
    try {
        log(`[CodeAnalysis] 🔊 Speaking analysis result: "${answer}"`);
        
        // Set active flag
        codeAnalysisTTSActive = true;
        
        // Truncate very long responses to prevent filename length errors
        let speechText = answer;
        if (answer.length > 200) {
            // Find a good breaking point (sentence end or period)
            const truncated = answer.substring(0, 200);
            const lastPeriod = truncated.lastIndexOf('.');
            const lastExclamation = truncated.lastIndexOf('!');
            const lastQuestion = truncated.lastIndexOf('?');
            
            const breakPoint = Math.max(lastPeriod, lastExclamation, lastQuestion);
            if (breakPoint > 100) {
                speechText = answer.substring(0, breakPoint + 1);
            } else {
                speechText = truncated + "...";
            }
            
            log(`[CodeAnalysis] 🔊 Truncated long response from ${answer.length} to ${speechText.length} characters`);
        }
        
        // Get current lineAbortController dynamically to ensure we have the latest one
        const { lineAbortController } = require('./stop_reading');
        
        // Use speakGPT directly for better command+. support
        await speakGPT(speechText, lineAbortController.signal);
        log(`[CodeAnalysis] 🔊 Speech completed successfully`);
        
        // Clear active flag on successful completion
        codeAnalysisTTSActive = false;
        
    } catch (error) {
        // Clear active flag on error
        codeAnalysisTTSActive = false;
        
        // Check if error is due to abort signal (command+. pressed)
        if (error instanceof Error && error.name === 'AbortError') {
            log(`[CodeAnalysis] 🔊 Speech aborted by user (command+.)`);
            return;
        }
        
        logError(`[CodeAnalysis] 🚨 Speech failed: ${error}`);
        
        // Fallback: show status bar message indicating speech failure
        vscode.window.setStatusBarMessage(`🔊 Speech failed: ${answer.substring(0, 100)}...`, 5000);
    }
}

/**
 * Register code analysis commands
 */
export function registerCodeAnalysis(context: vscode.ExtensionContext) {
    // Register command for manual code analysis
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.analyzeCode', async () => {
            const question = await vscode.window.showInputBox({
                placeHolder: 'Ask a question about your code...',
                prompt: 'Code Analysis: Ask about code state, functions, variables, etc.',
                value: '',
                ignoreFocusOut: true
            });

            if (question) {
                await analyzeCodeWithQuestion(question);
            }
        })
    );
    
    logSuccess('[CodeAnalysis] Code analysis commands registered');
}
