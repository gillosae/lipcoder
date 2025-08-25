import * as vscode from 'vscode';
import { speakTokenList, TokenChunk } from '../audio';
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
 * Get comprehensive code context from the current editor
 */
async function getCodeContext(editor: vscode.TextEditor): Promise<CodeContext> {
    const document = editor.document;
    const selection = editor.selection;
    const position = editor.selection.active;
    
    const context: CodeContext = {
        fileName: document.fileName,
        language: document.languageId,
        selectedText: document.getText(selection),
        fullText: document.getText(),
        cursorPosition: position
    };
    
    // Try to get current function name
    try {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );
        
        if (symbols) {
            const currentFunction = findCurrentFunction(symbols, position);
            if (currentFunction) {
                context.currentFunction = currentFunction.name;
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
    
    // Create a comprehensive prompt for code analysis
    const prompt = `You are a code analysis assistant that answers questions about code in both English and Korean. 

Question: "${question}"

Code Context:
- File: ${context.fileName}
- Language: ${context.language}
- Current function: ${context.currentFunction || 'Not in a function'}
- Selected text: ${context.selectedText || 'None'}

Code:
\`\`\`${context.language}
${context.fullText}
\`\`\`

Please analyze the code and answer the question. Common question types include:
- Code state/status questions (지금 코드가 어떤 상태야?)
- Function explanations (어떤 함수에 대해 설명해줘, 지금 내가 있는 함수는 뭐하는 함수야?)
- Variable counts (지금 전역변수가 몇개야?)
- Code structure questions
- Bug detection
- Code quality assessment

Special handling for Korean function analysis questions:
- When asked "지금 내가 있는 함수는 뭐하는 함수야?" or similar, focus on explaining the current function's purpose, parameters, return value, and main logic.
- Provide detailed explanations in Korean including what the function does, how it works, and its role in the codebase.

Provide a clear, concise answer in the same language as the question. If the question is in Korean, answer in Korean. If in English, answer in English.

Response format:
{
  "answer": "Direct answer to the question",
  "details": "Additional details if needed (optional)",
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
    const { fullText, language, currentFunction } = context;
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
    
    // Generate basic answer based on question type
    let answer = '';
    
    if (question.includes('상태') || question.includes('state')) {
        answer = `현재 ${language} 파일은 ${statistics.lines}줄이며, ${statistics.functions}개의 함수와 ${statistics.classes}개의 클래스를 포함하고 있습니다.`;
    } else if (question.includes('함수') || question.includes('function')) {
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
                
                answer = `현재 ${currentFunction} 함수 안에 있습니다. 이 함수는 ${language} 언어로 작성되었으며, 코드를 분석해보면 주요 기능을 수행하는 함수로 보입니다. 전체 파일에는 ${statistics.functions}개의 함수가 있습니다.`;
            } else {
                answer = `현재 ${currentFunction} 함수 안에 있습니다. 전체 파일에는 ${statistics.functions}개의 함수가 있습니다.`;
            }
        } else {
            answer = `현재 함수 밖에 있습니다. 전체 파일에는 ${statistics.functions}개의 함수가 있습니다.`;
        }
    } else if (question.includes('변수') || question.includes('variable')) {
        answer = `전체 파일에 약 ${statistics.variables}개의 변수 선언이 있습니다.`;
    } else {
        answer = `${language} 파일 분석 결과: ${statistics.lines}줄, ${statistics.functions}개 함수, ${statistics.variables}개 변수, ${statistics.classes}개 클래스`;
    }
    
    return {
        question,
        answer,
        statistics
    };
}

/**
 * Show result in popup and speak it
 */
async function showAndSpeakResult(result: CodeAnalysisResult): Promise<void> {
    const { question, answer, details, statistics } = result;
    
    log(`[CodeAnalysis] 📋 SHOW AND SPEAK RESULT CALLED`);
    log(`[CodeAnalysis] 📋 Question: "${question}"`);
    log(`[CodeAnalysis] 📋 Answer: "${answer}"`);
    
    // Prepare display message
    let displayMessage = answer;
    if (details) {
        displayMessage += `\n\n${details}`;
    }
    if (statistics) {
        displayMessage += `\n\n통계: 함수 ${statistics.functions}개, 변수 ${statistics.variables}개, 클래스 ${statistics.classes}개, 총 ${statistics.lines}줄`;
    }
    
    // Show non-modal notification popup (bottom-right corner)
    log(`[CodeAnalysis] 📋 Showing popup with message: "${displayMessage}"`);
    vscode.window.showInformationMessage(displayMessage);
    
    // Speak the answer as plain text
    log(`[CodeAnalysis] 📋 About to call speakAnalysisResult...`);
    await speakAnalysisResult(answer);
    
    logSuccess(`[CodeAnalysis] Analysis completed for: "${question}"`);
}

/**
 * Convert analysis result to speech
 */
async function speakAnalysisResult(answer: string): Promise<void> {
    try {
        log(`[CodeAnalysis] 🔊 ATTEMPTING TO SPEAK: "${answer}"`);
        
        // Try multiple approaches to ensure speech works
        
        // Method 1: Use comment category (known to work)
        log(`[CodeAnalysis] 🔊 Method 1: Trying with comment category...`);
        try {
            const chunks1: TokenChunk[] = [{
                tokens: [answer],
                category: 'comment'  // Use comment category which should work
            }];
            
            log(`[CodeAnalysis] 🔊 Calling speakTokenList with comment category: ${JSON.stringify(chunks1)}`);
            await speakTokenList(chunks1);
            log(`[CodeAnalysis] 🔊 Method 1 (comment category) completed successfully`);
            return; // Success, exit early
        } catch (method1Error) {
            logError(`[CodeAnalysis] 🚨 Method 1 failed: ${method1Error}`);
        }
        
        // Method 2: Use undefined category (original approach)
        log(`[CodeAnalysis] 🔊 Method 2: Trying with undefined category...`);
        try {
            const chunks2: TokenChunk[] = [{
                tokens: [answer],
                category: undefined  // No category = plain text TTS
            }];
            
            log(`[CodeAnalysis] 🔊 Calling speakTokenList with undefined category: ${JSON.stringify(chunks2)}`);
            await speakTokenList(chunks2);
            log(`[CodeAnalysis] 🔊 Method 2 (undefined category) completed successfully`);
            return; // Success, exit early
        } catch (method2Error) {
            logError(`[CodeAnalysis] 🚨 Method 2 failed: ${method2Error}`);
        }
        
        // Method 3: Direct TTS call
        log(`[CodeAnalysis] 🔊 Method 3: Trying direct TTS generation...`);
        try {
            const { genTokenAudio } = await import('../tts.js');
            const audioPath = await genTokenAudio(answer, undefined);
            log(`[CodeAnalysis] 🔊 Direct TTS generated audio at: ${audioPath}`);
            
            const { playWave } = await import('../audio.js');
            await playWave(audioPath);
            log(`[CodeAnalysis] 🔊 Method 3 (direct TTS) completed successfully`);
            return; // Success, exit early
        } catch (method3Error) {
            logError(`[CodeAnalysis] 🚨 Method 3 failed: ${method3Error}`);
        }
        
        throw new Error('All speech methods failed');
        
    } catch (error) {
        logError(`[CodeAnalysis] 🚨 ALL SPEECH METHODS FAILED: ${error}`);
        logError(`[CodeAnalysis] 🚨 Error stack: ${error instanceof Error ? error.stack : 'No stack'}`);
        
        // Try fallback speech method
        try {
            log(`[CodeAnalysis] 🔊 Trying fallback notification...`);
            vscode.window.showInformationMessage(`Speaking: ${answer}`);
        } catch (fallbackError) {
            logError(`[CodeAnalysis] 🚨 Fallback also failed: ${fallbackError}`);
        }
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
