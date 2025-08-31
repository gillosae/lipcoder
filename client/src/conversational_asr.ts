import * as vscode from 'vscode';
import { log, logError, logSuccess, logWarning } from './utils';
import { callLLMForCompletion, getOpenAIClient, getClaudeClient } from './llm';
import { currentLLMBackend, LLMBackend, claudeConfig } from './config';
import { speakTokenList, speakGPT, TokenChunk, playEarcon, startThinkingAudio, stopThinkingAudio, playThinkingFinished } from './audio';
import { CommandRouter } from './command_router';
import { activateVibeCoding } from './features/vibe_coding';
import { isTerminalSuggestionDialogActive } from './features/terminal';
import { saveSuggestions, hasCurrentSuggestions, showCurrentSuggestions } from './features/suggestion_storage';
import { tryExactCommand } from './features/exact_commands';
import { lineAbortController } from './features/stop_reading';
import * as path from 'path';

export interface ConversationalIntent {
    type: 'question' | 'command' | 'vibe_coding' | 'clarification' | 'unknown';
    confidence: number;
    originalText: string;
    intent: string;
    parameters?: Record<string, any>;
}

export interface ConversationalResponse {
    response: string;
    actions: ConversationalAction[];
    shouldSpeak: boolean;
}

export interface ConversationalAction {
    id: string;
    label: string;
    description: string;
    command: string;
    parameters?: Record<string, any>;
    icon?: string;
    type?: string;
}

/**
 * Main conversational ASR processor that handles natural language understanding
 * and generates conversational responses with action options
 */
export class ConversationalASRProcessor {
    private conversationHistory: Array<{text: string, timestamp: number}> = [];
    private readonly maxHistoryLength = 5;
    private lastFoundFiles: Array<{name: string, path: string, type: string}> = [];
    private lastOperationContext: string = '';

    /**
     * Process ASR transcription and generate conversational response
     */
    async processTranscription(transcriptionText: string, context?: {mode?: 'command' | 'write'}): Promise<ConversationalResponse> {
        try {
            log(`[ConversationalASR] Processing: "${transcriptionText}"`);
            
            // Start thinking audio during LLM processing
            await startThinkingAudio();
            
            // Add to conversation history
            this.addToHistory(transcriptionText);
            
            // Check for "continue" command first (before LLM processing)
            if (this.isContinueCommand(transcriptionText)) {
                log(`[ConversationalASR] Continue command detected: "${transcriptionText}"`);
                await stopThinkingAudio(); // Stop thinking audio immediately
                return await this.handleContinueCommand();
            }
            
            // Check for exact commands (bypass LLM for speed)
            log(`[ConversationalASR] Checking for exact commands: "${transcriptionText}"`);
            const exactCommandResult = await tryExactCommand(transcriptionText);
            if (exactCommandResult) {
                log(`[ConversationalASR] Exact command executed: "${transcriptionText}" -> ${exactCommandResult.response}`);
                await stopThinkingAudio(); // Stop thinking audio immediately
                return exactCommandResult;
            } else {
                log(`[ConversationalASR] No exact command found, proceeding to LLM: "${transcriptionText}"`);
            }
            
            // Understand intent using LLM
            const intent = await this.understandIntent(transcriptionText, context);
            log(`[ConversationalASR] Intent: ${intent.type} (confidence: ${intent.confidence})`);
            log(`[ConversationalASR] Intent details: ${JSON.stringify(intent)}`);
            
            // Generate conversational response with actions
            const response = await this.generateConversationalResponse(intent, context);
            
            // Stop thinking audio and play finished sound
            await playThinkingFinished();
            
            // Provide immediate audio feedback
            if (response.shouldSpeak) {
                await this.speakResponse(response.response);
            }
            
            // Clear actions for ASR commands to prevent continuing quickpicks
            response.actions = [];
            
            return response;
            
        } catch (error) {
            // Make sure to stop thinking audio even if processing fails
            await stopThinkingAudio();
            logError(`[ConversationalASR] Error processing transcription: ${error}`);
            return this.createErrorResponse(transcriptionText);
        }
    }

    /**
     * Check if the user said a "continue" command
     */
    private isContinueCommand(text: string): boolean {
        const normalizedText = text.toLowerCase().trim();
        const continuePatterns = [
            'continue',
            'continue with suggestions',
            'show suggestions',
            'show options',
            'proceed',
            'go ahead',
            'next'
        ];
        
        return continuePatterns.some(pattern => 
            normalizedText === pattern || 
            normalizedText.includes(pattern)
        );
    }

    /**
     * Handle continue command - show saved suggestions
     */
    private async handleContinueCommand(): Promise<ConversationalResponse> {
        log(`[ConversationalASR] Handling continue command`);
        
        if (!hasCurrentSuggestions()) {
            log(`[ConversationalASR] No saved suggestions available`);
            return {
                response: "No saved suggestions available. Use voice commands to generate suggestions first.",
                actions: [],
                shouldSpeak: true
            };
        }
        
        try {
            // Show the suggestions and let user select
            const selectedAction = await showCurrentSuggestions();
            
            if (selectedAction) {
                log(`[ConversationalASR] User selected suggestion: "${selectedAction.label}"`);
                
                // Execute the selected action
                await this.executeSuggestionAction(selectedAction);
                
                return {
                    response: "", // Silent execution
                    actions: [],
                    shouldSpeak: false // Don't speak or show popup
                };
            } else {
                log(`[ConversationalASR] User cancelled suggestion selection`);
                return {
                    response: "", // Silent cancellation
                    actions: [],
                    shouldSpeak: false // Don't speak or show popup
                };
            }
        } catch (error) {
            logError(`[ConversationalASR] Error handling continue command: ${error}`);
            return {
                response: "", // Silent error (logged instead)
                actions: [],
                shouldSpeak: false
            };
        }
    }

    /**
     * Generate simple navigation feedback
     */
    private generateNavigationFeedback(originalText: string): string {
        const text = originalText.toLowerCase();
        
        if (text.includes('explorer')) {
            return 'In explorer';
        } else if (text.includes('editor')) {
            return 'In editor';
        } else if (text.includes('terminal')) {
            return 'In terminal';
        } else if (text.includes('panel')) {
            return 'Panel switched';
        } else if (text.includes('tab')) {
            return 'Tab switched';
        } else if (text.includes('line')) {
            return 'Line navigated';
        } else if (text.includes('function')) {
            return 'Function found';
        } else if (text.includes('file')) {
            return 'File opened';
        } else {
            return 'Navigated';
        }
    }

    /**
     * Generate simple success feedback
     */
    private generateSuccessFeedback(originalText: string): string {
        const text = originalText.toLowerCase();
        
        if (text.includes('save')) {
            return 'Saved';
        } else if (text.includes('format')) {
            return 'Formatted';
        } else if (text.includes('copy')) {
            return 'Copied';
        } else if (text.includes('paste')) {
            return 'Pasted';
        } else if (text.includes('delete')) {
            return 'Deleted';
        } else if (text.includes('close')) {
            return 'Closed';
        } else if (text.includes('open')) {
            return 'Opened';
        } else {
            return 'Done';
        }
    }

    /**
     * Execute a selected suggestion action
     */
    public async executeSuggestionAction(action: ConversationalAction): Promise<void> {
        log(`[ConversationalASR] Executing suggestion action: ${action.command}`);
        
        switch (action.command) {
            case 'vibe_coding':
                if (action.parameters?.instruction) {
                    await activateVibeCoding(action.parameters.instruction);
                }
                break;
                
            case 'code':
            case 'modify':
            case 'refactor':
            case 'document':
                // These all use vibe coding
                const instruction = action.parameters?.instruction || action.label;
                await activateVibeCoding(instruction);
                break;
                
            default:
                // For other commands, try to execute them via VS Code command palette
                log(`[ConversationalASR] Attempting to execute command: ${action.command}`);
                try {
                    await vscode.commands.executeCommand(`lipcoder.${action.command}`, action.parameters);
                } catch (error) {
                    log(`[ConversationalASR] Command execution failed, trying direct execution: ${error}`);
                    // If that fails, try some common patterns
                    if (action.command === 'insertText' && action.parameters && action.parameters.text) {
                        const editor = vscode.window.activeTextEditor;
                        if (editor) {
                            await editor.edit(editBuilder => {
                                editBuilder.insert(editor.selection.active, action.parameters!.text);
                            });
                        }
                    }
                }
                break;
        }
    }

    /**
     * Understand user intent using LLM
     */
    private async understandIntent(text: string, context?: {mode?: 'command' | 'write'}): Promise<ConversationalIntent> {
        const systemPrompt = `You are an AI assistant that understands user intent in a code editor context. 
Analyze the user's natural language input and classify it into one of these categories:

1. "question" - User is asking about code, seeking explanation, or requesting information
2. "command" - User wants to perform a specific action (navigate, search, open files, etc.)
3. "vibe_coding" - User wants to modify/generate/implement code using natural language
4. "clarification" - User is responding to a previous question or clarifying something
5. "unknown" - Intent is unclear - ONLY use this as a last resort

IMPORTANT CLASSIFICATION RULES:
- If the user mentions implementing, creating, adding, modifying, completing, or working on code → vibe_coding
- If the user wants to navigate, search, open, or perform editor actions → command
- If the user asks "what", "how", "why" about code → question
- If the user asks about images, pictures, graphics, charts, or visual content → command (image description)
- If the user asks about terminal output, terminal results, terminal errors, or terminal analysis → command (terminal analysis)

Examples:
- "What does this function do?" → question
- "Go to line 50" → command  
- "Add error handling to this function" → vibe_coding
- "Let's complete the implementation" → vibe_coding
- "Create a new function" → vibe_coding
- "Implement the fetch function" → vibe_coding
- "Modify this code to use async/await" → vibe_coding
- "Yes, apply the changes" → clarification
- "Find all references to getUserData" → command
- "Open terminal" → command
- "Save file" → command
- "Format document" → command
- "Symbol tree" → command
- "Go to explorer" → command
- "Read line tokens" → command
- "Find function main" → command
- "Terminal up" → command
- "터미널 결과 설명해줘" → command (terminal analysis)
- "터미널 출력 설명" → command (terminal analysis)
- "터미널 에러 설명" → command (terminal analysis)
- "explain terminal output" → command (terminal analysis)
- "파이썬 파일 열어줘" → command (parameters: {"fileType": "python"})
- "Python 파일 열어줘" → command (parameters: {"fileType": "python"})
- "open python file" → command (parameters: {"fileType": "python"})
- "자바스크립트 파일 열어" → command (parameters: {"fileType": "javascript"})
- "open javascript file" → command (parameters: {"fileType": "javascript"})

IMAGE DESCRIPTION EXAMPLES (all → command):
- "그림에서 막대의 색이 다른지 알려줘" → command
- "이미지에서 뭐가 보이는지 설명해줘" → command  
- "차트에서 어떤 데이터를 보여주는지 말해줘" → command
- "그래프의 트렌드가 어떻게 되는지 알려줘" → command
- "사진에서 몇 개의 객체가 있는지 세어줘" → command
- "그림에서 텍스트가 뭐라고 써있는지 읽어줘" → command
- "이미지의 색깔이 어떻게 다른지 설명해줘" → command
- "그림에서 사람이 몇 명인지 알려줘" → command
- "차트의 최대값이 뭔지 말해줘" → command
- "그림이 바 플롯이야?" → command
- "이 차트가 선 그래프인가?" → command
- "막대들이 같은 색깔이야?" → command
- "png 파일에서 뭐가 보여?" → command
- "그림에 강아지가 있어?" → command
- "이미지에 사람이 보여?" → command
- "차트에 빨간색 막대가 있나?" → command

CSV FILE ANALYSIS EXAMPLES (all → command):
- "movies.csv 파일에 대해 설명해줘" → command (parameters: {"filename": "movies.csv", "operation": "analyze"})
- "sample_data.csv 구조 알려줘" → command (parameters: {"filename": "sample_data.csv", "operation": "analyze"})
- "users.csv 파일 분석해줘" → command (parameters: {"filename": "users.csv", "operation": "analyze"})
- "data.csv에 어떤 컬럼이 있는지 말해줘" → command (parameters: {"filename": "data.csv", "operation": "analyze"})
- "CSV 파일 movies.csv 설명해줘" → command (parameters: {"filename": "movies.csv", "operation": "analyze"})
- "analyze movies.csv file" → command (parameters: {"filename": "movies.csv", "operation": "analyze"})
- "tell me about sample_data.csv" → command (parameters: {"filename": "sample_data.csv", "operation": "analyze"})
- "describe users.csv structure" → command (parameters: {"filename": "users.csv", "operation": "analyze"})

VIBE CODING KEYWORDS: implement, create, add, modify, complete, generate, write, build, make, develop, code, function, class, method, fix, improve, refactor, change

IMAGE DESCRIPTION KEYWORDS: 그림, 이미지, 사진, 차트, 그래프, 도표, 막대, 색깔, 색상, 개수, 몇 개, 몇 명, 텍스트, 글자, 문자, 숫자, 데이터, 트렌드, 경향, 최대값, 최소값, 플롯, 바, 선, 점, 원, picture, image, chart, graph, color, count, text, number, data, trend, plot, bar, line, point, circle, png, jpg, jpeg

CSV FILE ANALYSIS KEYWORDS: csv, CSV, 파일, 설명, 분석, 구조, 컬럼, 데이터, 테이블, file, analyze, describe, structure, column, table, explain, about

TERMINAL ANALYSIS KEYWORDS: 터미널, terminal, 출력, output, 결과, result, 에러, error, 오류, 분석, analyze, explain, describe, 설명

Respond in JSON format:
{
  "type": "question|command|vibe_coding|clarification|unknown",
  "confidence": 0.95,
  "intent": "brief description of what user wants",
  "parameters": {
    "fileType": "python|javascript|typescript|json|markdown|text|css|html|java|cpp|c|shell",
    "filename": "specific_filename.ext",
    "operation": "open|save|close|format",
    "other": "value"
  }
}`;

        const userPrompt = `User said: "${text}"
        
Context from recent conversation:
${this.getRecentHistory()}

Analyze the intent:`;

        try {
            // Use ChatGPT specifically for fast intent understanding
            const openaiClient = getOpenAIClient();
            if (!openaiClient) {
                throw new Error('OpenAI client not available');
            }
            
            const completion = await openaiClient.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 200,
                temperature: 0.3
            });
            
            const response = completion.choices[0]?.message?.content || '';
            log(`[ConversationalASR] Intent classification response: ${response}`);
            const parsed = JSON.parse(response);
            
            const intent = {
                type: parsed.type || 'unknown',
                confidence: parsed.confidence || 0.5,
                originalText: text,
                intent: parsed.intent || text,
                parameters: parsed.parameters || {}
            };
            
            log(`[ConversationalASR] Classified intent: ${intent.type} (confidence: ${intent.confidence})`);
            return intent;
        } catch (error) {
            logError(`[ConversationalASR] Intent parsing error: ${error}`);
            return {
                type: 'unknown',
                confidence: 0.1,
                originalText: text,
                intent: text
            };
        }
    }

    /**
     * Generate conversational response with action options
     */
    private async generateConversationalResponse(intent: ConversationalIntent, context?: {mode?: 'command' | 'write'}): Promise<ConversationalResponse> {
        log(`[ConversationalASR] Generating response for intent type: ${intent.type} with text: "${intent.originalText}"`);
        switch (intent.type) {
            case 'question':
                log(`[ConversationalASR] Routing to handleQuestion`);
                return await this.handleQuestion(intent);
            case 'command':
                log(`[ConversationalASR] Routing to handleCommand`);
                return await this.handleCommand(intent, context);
            case 'vibe_coding':
                log(`[ConversationalASR] 🎯 Routing to handleVibeCoding - DYNAMIC SUGGESTIONS SHOULD APPEAR`);
                return await this.handleVibeCoding(intent);
            case 'clarification':
                log(`[ConversationalASR] Routing to handleClarification`);
                return await this.handleClarification(intent);
            default:
                log(`[ConversationalASR] Routing to handleUnknown`);
                return await this.handleUnknown(intent);
        }
    }

    /**
     * Handle question-type intents with context-aware responses
     */
    private async handleQuestion(intent: ConversationalIntent): Promise<ConversationalResponse> {
        try {
            // Check if this is a follow-up question about recently found files
            const followUpRequest = this.detectFileFollowUpQuestion(intent.originalText);
            if (followUpRequest.isFollowUp) {
                return await this.handleFileFollowUpQuestion(intent, followUpRequest);
            }
            
            // Check if this should use LLM-generated bash script
            const llmBashRequest = this.detectLLMBashRequest(intent.originalText);
            if (llmBashRequest.shouldUseLLM) {
                return await this.handleLLMBashRequest(intent, llmBashRequest);
            }
            
            // Check if this is a file-related question that should use bash script
            const fileQuestion = this.detectFileQuestion(intent.originalText);
            if (fileQuestion.isFileQuestion) {
                return await this.handleFileQuestion(intent, fileQuestion);
            }
            
            // Get current editor context
            const editor = vscode.window.activeTextEditor;
            let contextInfo = '';
            let relevantActions: ConversationalAction[] = [];
            
            if (editor) {
                const document = editor.document;
                const selection = editor.selection;
                const currentLine = document.lineAt(selection.active.line).text;
                const fileName = document.fileName.split('/').pop() || 'current file';
                const language = document.languageId;
                
                contextInfo = `
Current context:
- File: ${fileName} (${language})
- Current line: "${currentLine.trim()}"
- Line number: ${selection.active.line + 1}`;

                // Generate context-aware actions based on the file and question
                if (intent.originalText.toLowerCase().includes('class') || intent.originalText.toLowerCase().includes('calculator')) {
                    relevantActions.push({
                        id: 'find_class',
                        label: 'Find Calculator Class',
                        description: 'Navigate to Calculator class definition',
                        command: 'findFunction',
                        parameters: { name: 'Calculator' },
                        icon: '$(symbol-class)'
                    });
                }
                
                if (intent.originalText.toLowerCase().includes('birthday') || intent.originalText.toLowerCase().includes('date')) {
                    relevantActions.push({
                        id: 'create_birthday_calculator',
                        label: 'Create BirthdayCalculator',
                        description: 'Generate a birthday calculator class',
                        command: 'vibeCoding',
                        parameters: { instruction: 'create a birthday calculator class' },
                        icon: '$(add)'
                    });
                }
                
                relevantActions.push({
                    id: 'analyze_current_code',
                    label: 'Analyze This Code',
                    description: 'Get detailed analysis of current code',
                    command: 'analyzeCode',
                    icon: '$(search)'
                });
            }
            
            // If no specific actions were generated, add generic helpful ones
            if (relevantActions.length === 0) {
                relevantActions = [
                    {
                        id: 'symbol_tree',
                        label: 'Show Symbol Tree',
                        description: 'View all classes and functions',
                        command: 'symbolTree',
                        icon: '$(symbol-class)'
                    },
                    {
                        id: 'function_list',
                        label: 'List Functions',
                        description: 'Show all functions in file',
                        command: 'functionList',
                        icon: '$(symbol-function)'
                    },
                    {
                        id: 'ask_followup',
                        label: 'Ask Follow-up',
                        description: 'Ask another question',
                        command: 'askQuestion',
                        icon: '$(comment-discussion)'
                    }
                ];
            }

            // Generate context-aware response
            const systemPrompt = `You are a helpful coding assistant. The user asked a question about code. 
Provide a brief, conversational response (2-3 sentences) that directly addresses their question.
Be specific and helpful, like explaining to a colleague.

If they ask about a specific class or function, explain what it likely does.
If they ask about creating something, acknowledge that and suggest next steps.
Keep it natural and encouraging.`;

            const userPrompt = `User asked: "${intent.originalText}"
${contextInfo}

Provide a helpful, conversational response:`;

            // Use ChatGPT for fast question responses
            const openaiClient = getOpenAIClient();
            if (!openaiClient) {
                throw new Error('OpenAI client not available');
            }
            
            const completion = await openaiClient.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 300,
                temperature: 0.7
            });
            
            const response = completion.choices[0]?.message?.content || '';
            
            return {
                response: response.trim(),
                actions: relevantActions.slice(0, 3), // Limit to 3 actions
                shouldSpeak: true
            };
            
        } catch (error) {
            return this.createErrorResponse(intent.originalText);
        }
    }

    /**
     * Handle command-type intents
     */
    private async handleCommand(intent: ConversationalIntent, context?: {mode?: 'command' | 'write'}): Promise<ConversationalResponse> {
        try {
            // Try to execute the command first to check if it's a navigation command
            log(`[ConversationalASR] About to try executing command: "${intent.originalText}"`);
            const commandExecuted = await this.tryExecuteCommand(intent);
            log(`[ConversationalASR] Command execution result: ${commandExecuted}`);
            
            // Check if command was executed successfully - provide appropriate feedback
            if (commandExecuted === 'navigation') {
                log(`[ConversationalASR] Navigation command completed - providing audio feedback only`);
                // Generate simple navigation feedback without popup
                const navResponse = this.generateNavigationFeedback(intent.originalText);
                return {
                    response: navResponse, // Simple navigation confirmation
                    actions: [], // No suggestions for navigation commands
                    shouldSpeak: true // Speak the navigation confirmation
                };
            } else if (commandExecuted === true) {
                log(`[ConversationalASR] Command executed successfully - providing audio feedback only`);
                // Generate simple success feedback without popup
                const successResponse = this.generateSuccessFeedback(intent.originalText);
                return {
                    response: successResponse, // Simple success confirmation
                    actions: [], // No suggestions for executed commands
                    shouldSpeak: true // Speak the success confirmation
                };
            }
            
            // Only generate LLM response if it's not a navigation command
            const systemPrompt = `The user wants to execute a command in the code editor. 
Provide a brief acknowledgment (1 sentence) that you understand what they want to do.
Be conversational and confirm the action.`;

            const userPrompt = `User command: "${intent.originalText}"
Intent: ${intent.intent}

Provide a brief acknowledgment:`;

            // Use ChatGPT for fast command acknowledgments
            const openaiClient = getOpenAIClient();
            if (!openaiClient) {
                throw new Error('OpenAI client not available');
            }
            
            const completion = await openaiClient.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 100,
                temperature: 0.7
            });
            
            const response = completion.choices[0]?.message?.content || '';
            const actions: ConversationalAction[] = [];
            
            if (!commandExecuted) {
                // If command couldn't be executed, provide options
                if (context?.mode === 'write') {
                    // In write mode, offer text insertion as primary option
                    actions.push(
                        {
                            id: 'insert_text',
                            label: 'Insert as Text',
                            description: 'Insert the spoken text directly',
                            command: 'insertText',
                            parameters: { text: intent.originalText },
                            icon: '$(edit)'
                        },
                        {
                            id: 'retry_command',
                            label: 'Try as Command',
                            description: 'Attempt to execute as a command',
                            command: 'retryCommand',
                            parameters: { originalText: intent.originalText },
                            icon: '$(terminal)'
                        },
                        {
                            id: 'vibe_code',
                            label: 'Vibe Code',
                            description: 'Use as code modification instruction',
                            command: 'vibeCoding',
                            icon: '$(wand)'
                        }
                    );
                } else {
                    // In command mode, focus on command options
                    actions.push(
                        {
                            id: 'retry_command',
                            label: 'Try Again',
                            description: 'Attempt the command again',
                            command: 'retryCommand',
                            parameters: { originalText: intent.originalText },
                            icon: '$(refresh)'
                        },
                        {
                            id: 'clarify_command',
                            label: 'Clarify',
                            description: 'Provide more details about what you want',
                            command: 'clarifyCommand',
                            icon: '$(question)'
                        },
                        {
                            id: 'show_commands',
                            label: 'Show Commands',
                            description: 'See available commands',
                            command: 'showCommands',
                            icon: '$(list-unordered)'
                        }
                    );
                }
            } else {
                // Command executed successfully, suggest follow-up actions
                actions.push(
                    {
                        id: 'continue_editing',
                        label: 'Continue Editing',
                        description: 'Make more changes to the code',
                        command: 'continueEditing',
                        icon: '$(edit)'
                    },
                    {
                        id: 'vibe_code',
                        label: 'Vibe Code',
                        description: 'Modify code with natural language',
                        command: 'vibeCoding',
                        icon: '$(wand)'
                    }
                );
            }

            return {
                response: response.trim(),
                actions,
                shouldSpeak: true
            };
        } catch (error) {
            return this.createErrorResponse(intent.originalText);
        }
    }

    /**
     * Handle vibe coding intents - execute immediately for code creation requests
     */
    private async handleVibeCoding(intent: ConversationalIntent): Promise<ConversationalResponse> {
        try {
            // Execute vibe coding immediately for code creation requests
            log(`[ConversationalASR] Executing vibe coding immediately for: ${intent.originalText}`);
            
            // Call activateVibeCoding directly with the instruction
            await activateVibeCoding(intent.originalText, { suppressConversationalASR: true });
            
            return {
                response: "Executing your code request...",
                actions: [],
                shouldSpeak: false // Let vibe coding handle its own audio feedback
            };
        } catch (error) {
            return this.createErrorResponse(intent.originalText);
        }
    }

    /**
     * Handle clarification intents
     */
    private async handleClarification(intent: ConversationalIntent): Promise<ConversationalResponse> {
        const response = "Got it! Let me help you with that.";
        
        const actions: ConversationalAction[] = [
            {
                id: 'continue_conversation',
                label: 'Continue',
                description: 'Keep the conversation going',
                command: 'continueConversation',
                icon: '$(comment)'
            },
            {
                id: 'new_request',
                label: 'New Request',
                description: 'Start a new request',
                command: 'newRequest',
                icon: '$(add)'
            }
        ];

        return {
            response,
            actions,
            shouldSpeak: true
        };
    }

    /**
     * Handle unknown intents - try CommandRouter first before falling back to generic options
     */
    private async handleUnknown(intent: ConversationalIntent): Promise<ConversationalResponse> {
        log(`[ConversationalASR] Handling unknown intent, trying CommandRouter first: "${intent.originalText}"`);
        
        // First, try to execute through the comprehensive CommandRouter
        const commandExecuted = await this.tryExecuteCommand(intent);
        
        if (commandExecuted === 'navigation') {
            log(`[ConversationalASR] Navigation command completed in unknown handler - suppressing all feedback`);
            return {
                response: "", // No response text for navigation commands
                actions: [],
                shouldSpeak: false
            };
        }
        
        if (commandExecuted) {
            log(`[ConversationalASR] CommandRouter successfully handled unknown intent: "${intent.originalText}"`);
            return {
                response: "Command executed successfully!",
                actions: [
                    {
                        id: 'continue_editing',
                        label: 'Continue Editing',
                        description: 'Return to editing',
                        command: 'continueEditing',
                        icon: '$(edit)'
                    }
                ],
                shouldSpeak: true
            };
        }
        
        // If CommandRouter couldn't handle it, show generic options
        log(`[ConversationalASR] CommandRouter couldn't handle intent, showing generic options: "${intent.originalText}"`);
        const response = "I'm not sure what you'd like me to do. Could you clarify?";
        
        const actions: ConversationalAction[] = [
            {
                id: 'retry_command',
                label: 'Try as Command',
                description: 'Retry as a direct command',
                command: 'retryCommand',
                parameters: { originalText: intent.originalText },
                icon: '$(terminal)'
            },
            {
                id: 'ask_question',
                label: 'Ask Question',
                description: 'Ask about code or functionality',
                command: 'askQuestion',
                icon: '$(question)'
            },
            {
                id: 'vibe_code',
                label: 'Vibe Code',
                description: 'Describe code changes you want',
                command: 'vibeCoding',
                icon: '$(wand)'
            },
            {
                id: 'insert_text',
                label: 'Insert as Text',
                description: 'Insert the spoken text directly',
                command: 'insertText',
                parameters: { text: intent.originalText },
                icon: '$(edit)'
            }
        ];

        return {
            response,
            actions,
            shouldSpeak: true
        };
    }

    /**
     * Generate dynamic suggestions based on current context and user intent
     */
    private async generateDynamicSuggestions(intent: ConversationalIntent): Promise<ConversationalAction[]> {
        try {
            log(`[ConversationalASR] Generating dynamic suggestions for: "${intent.originalText}"`);
            
            // Get current editor context
            const editor = vscode.window.activeTextEditor;
            let contextInfo = 'No active editor';
            let codebaseInfo = '';
            
            if (editor) {
                const document = editor.document;
                const selection = editor.selection;
                const currentLine = document.lineAt(selection.active.line).text;
                const fileName = document.fileName.split('/').pop() || 'current file';
                const language = document.languageId;
                const selectedText = document.getText(selection);
                
                // Get surrounding context (10 lines before and after for better context)
                const startLine = Math.max(0, selection.active.line - 10);
                const endLine = Math.min(document.lineCount - 1, selection.active.line + 10);
                const contextRange = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
                const surroundingCode = document.getText(contextRange);
                
                // Get file structure info
                const fileContent = document.getText();
                const imports = this.extractImports(fileContent, language);
                const functions = this.extractFunctions(fileContent, language);
                
                contextInfo = `
Current context:
- File: ${fileName} (${language})
- Current line ${selection.active.line + 1}: "${currentLine.trim()}"
- Selected text: "${selectedText.trim()}"
- File has ${document.lineCount} lines
- Imports: ${imports.join(', ') || 'none'}
- Functions: ${functions.join(', ') || 'none'}

Surrounding code (lines ${startLine + 1}-${endLine + 1}):
\`\`\`${language}
${surroundingCode}
\`\`\``;

                // Add conversation history context
                const recentHistory = this.getRecentHistory();
                if (recentHistory) {
                    codebaseInfo = `\nRecent conversation:\n${recentHistory}`;
                }
            }

            // Create a more specific prompt based on the intent and context
            const systemPrompt = `You are an expert coding assistant. Based on the user's request and current code context, generate 3-4 specific, actionable suggestions that would help the user continue their work.

IMPORTANT: Make suggestions that are:
1. Directly related to the current code and user's request
2. Specific and actionable (not generic)
3. Varied in type (explaining, coding, testing, debugging, etc.)
4. Immediately executable

For each suggestion, provide:
- A clear, specific label (max 4 words)
- A brief description of what it will do
- A detailed instruction for execution

Respond ONLY in valid JSON format:
{
  "suggestions": [
    {
      "id": "unique_id",
      "label": "Short Action Label",
      "description": "Brief description of what this will do",
      "type": "explain|code|modify|test|navigate|debug|refactor|document",
      "instruction": "Detailed instruction for what to do"
    }
  ]
}`;

            const userPrompt = `User request: "${intent.originalText}"
${contextInfo}${codebaseInfo}

Generate 3-4 helpful, specific suggestions for what the user might want to do next:`;

            log(`[ConversationalASR] Sending prompt to OpenAI...`);

            // Use ChatGPT for fast suggestion generation
            const openaiClient = getOpenAIClient();
            if (!openaiClient) {
                log(`[ConversationalASR] OpenAI client not available, using fallback suggestions`);
                return this.getFallbackSuggestions(intent);
            }
            
            const completion = await openaiClient.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 1000,
                temperature: 0.7
            });
            
            const response = completion.choices[0]?.message?.content || '';
            log(`[ConversationalASR] OpenAI response: ${response}`);
            
            if (!response.trim()) {
                throw new Error('Empty response from OpenAI');
            }

            // Clean and parse the response
            const cleanedResponse = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleanedResponse);
            
            if (!parsed.suggestions || !Array.isArray(parsed.suggestions)) {
                throw new Error('Invalid response format - missing suggestions array');
            }

            log(`[ConversationalASR] Parsed ${parsed.suggestions.length} suggestions`);
            
            // Convert suggestions to ConversationalAction format
            const actions: ConversationalAction[] = parsed.suggestions.map((suggestion: any, index: number) => ({
                id: suggestion.id || `suggestion_${index}`,
                label: suggestion.label || `Suggestion ${index + 1}`,
                description: suggestion.description || 'No description',
                command: 'executeDynamicSuggestion',
                parameters: {
                    type: suggestion.type || 'code',
                    instruction: suggestion.instruction || suggestion.description,
                    originalRequest: intent.originalText
                },
                icon: this.getIconForSuggestionType(suggestion.type || 'code')
            }));

            // Always include the traditional apply/reject options
            actions.push(
                {
                    id: 'apply_changes',
                    label: 'Apply Changes',
                    description: 'Accept and apply the code changes',
                    command: 'applyVibeChanges',
                    icon: '$(check)'
                },
                {
                    id: 'reject_changes',
                    label: 'Reject Changes',
                    description: 'Cancel the proposed changes',
                    command: 'rejectVibeChanges',
                    icon: '$(x)'
                }
            );

            log(`[ConversationalASR] Generated ${actions.length} total actions`);
            return actions.slice(0, 6); // Limit to 6 total actions
            
        } catch (error) {
            logError(`[ConversationalASR] Error generating dynamic suggestions: ${error}`);
            log(`[ConversationalASR] Using fallback suggestions due to error`);
            return this.getFallbackSuggestions(intent);
        }
    }

    /**
     * Get fallback suggestions when dynamic generation fails
     */
    private getFallbackSuggestions(intent: ConversationalIntent): ConversationalAction[] {
        // Create context-aware fallback suggestions based on the intent
        const suggestions: ConversationalAction[] = [];
        const request = intent.originalText.toLowerCase();

        // Add context-specific suggestions based on keywords
        if (request.includes('function') || request.includes('method')) {
            suggestions.push({
                id: 'explain_function',
                label: 'Explain Function',
                description: 'Explain what this function does',
                command: 'executeDynamicSuggestion',
                parameters: {
                    type: 'explain',
                    instruction: 'Explain the current function and its purpose',
                    originalRequest: intent.originalText
                },
                icon: '$(question)'
            });
        }

        if (request.includes('test') || request.includes('testing')) {
            suggestions.push({
                id: 'create_tests',
                label: 'Create Tests',
                description: 'Generate unit tests for this code',
                command: 'executeDynamicSuggestion',
                parameters: {
                    type: 'test',
                    instruction: 'Create comprehensive unit tests for the current code',
                    originalRequest: intent.originalText
                },
                icon: '$(beaker)'
            });
        }

        if (request.includes('error') || request.includes('exception') || request.includes('handling')) {
            suggestions.push({
                id: 'add_error_handling',
                label: 'Add Error Handling',
                description: 'Add try-catch and error handling',
                command: 'executeDynamicSuggestion',
                parameters: {
                    type: 'modify',
                    instruction: 'Add proper error handling with try-catch blocks',
                    originalRequest: intent.originalText
                },
                icon: '$(shield)'
            });
        }

        if (request.includes('document') || request.includes('comment')) {
            suggestions.push({
                id: 'add_documentation',
                label: 'Add Documentation',
                description: 'Add JSDoc comments and documentation',
                command: 'executeDynamicSuggestion',
                parameters: {
                    type: 'document',
                    instruction: 'Add comprehensive JSDoc comments and inline documentation',
                    originalRequest: intent.originalText
                },
                icon: '$(book)'
            });
        }

        // If no specific suggestions, add generic helpful ones
        if (suggestions.length === 0) {
            suggestions.push(
                {
                    id: 'improve_code',
                    label: 'Improve Code',
                    description: 'Suggest code improvements',
                    command: 'executeDynamicSuggestion',
                    parameters: {
                        type: 'refactor',
                        instruction: 'Analyze and improve the current code structure and quality',
                        originalRequest: intent.originalText
                    },
                    icon: '$(gear)'
                },
                {
                    id: 'explain_code',
                    label: 'Explain Code',
                    description: 'Explain what this code does',
                    command: 'executeDynamicSuggestion',
                    parameters: {
                        type: 'explain',
                        instruction: 'Provide a detailed explanation of the current code',
                        originalRequest: intent.originalText
                    },
                    icon: '$(question)'
                }
            );
        }

        // Always include the traditional options
        suggestions.push(
            {
                id: 'apply_changes',
                label: 'Apply Changes',
                description: 'Accept and apply the code changes',
                command: 'applyVibeChanges',
                icon: '$(check)'
            },
            {
                id: 'reject_changes',
                label: 'Reject Changes',
                description: 'Cancel the proposed changes',
                command: 'rejectVibeChanges',
                icon: '$(x)'
            }
        );

        return suggestions.slice(0, 6);
    }

    /**
     * Extract imports from code
     */
    private extractImports(code: string, language: string): string[] {
        const imports: string[] = [];
        const lines = code.split('\n');
        
        for (const line of lines.slice(0, 20)) { // Check first 20 lines
            const trimmed = line.trim();
            if (language === 'typescript' || language === 'javascript') {
                if (trimmed.startsWith('import ') || trimmed.startsWith('const ') && trimmed.includes('require(')) {
                    imports.push(trimmed);
                }
            } else if (language === 'python') {
                if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
                    imports.push(trimmed);
                }
            }
        }
        
        return imports.slice(0, 5); // Limit to 5 imports
    }

    /**
     * Extract function names from code
     */
    private extractFunctions(code: string, language: string): string[] {
        const functions: string[] = [];
        const lines = code.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (language === 'typescript' || language === 'javascript') {
                const funcMatch = trimmed.match(/(?:function\s+(\w+)|(\w+)\s*\(|(\w+):\s*\(|async\s+function\s+(\w+)|async\s+(\w+)\s*\()/);
                if (funcMatch) {
                    const funcName = funcMatch[1] || funcMatch[2] || funcMatch[3] || funcMatch[4] || funcMatch[5];
                    if (funcName && !functions.includes(funcName)) {
                        functions.push(funcName);
                    }
                }
            } else if (language === 'python') {
                const funcMatch = trimmed.match(/def\s+(\w+)\s*\(/);
                if (funcMatch && !functions.includes(funcMatch[1])) {
                    functions.push(funcMatch[1]);
                }
            }
        }
        
        return functions.slice(0, 5); // Limit to 5 functions
    }

    /**
     * Get appropriate icon for suggestion type
     */
    private getIconForSuggestionType(type: string): string {
        switch (type) {
            case 'explain': return '$(question)';
            case 'code': return '$(add)';
            case 'modify': return '$(edit)';
            case 'test': return '$(beaker)';
            case 'navigate': return '$(arrow-right)';
            case 'debug': return '$(debug)';
            case 'refactor': return '$(gear)';
            case 'document': return '$(book)';
            default: return '$(lightbulb)';
        }
    }

    /**
     * Try to execute a command based on intent
     */
    private async tryExecuteCommand(intent: ConversationalIntent): Promise<boolean | string> {
        try {
            // Skip exact command check here since it was already done in processTranscription
            log(`[ConversationalASR] Trying to execute command via CommandRouter: "${intent.originalText}"`);
            
            // Try CommandRouter first for comprehensive command handling
            try {
                log(`[ConversationalASR] Creating CommandRouter for command execution...`);
                const commandRouter = new CommandRouter({ 
                    enableLogging: true,
                    showNotifications: true 
                });
                
                // Set editor context for proper command execution
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const context = {
                        editor: editor,
                        position: editor.selection.active,
                        selection: editor.selection,
                        documentUri: editor.document.uri
                    };
                    commandRouter.setEditorContext(context);
                    log(`[ConversationalASR] Editor context set for CommandRouter`);
                }
                
                log(`[ConversationalASR] CommandRouter processing: "${intent.originalText}"`);
                const result = await commandRouter.processTranscription(intent.originalText);
                log(`[ConversationalASR] CommandRouter result: ${result}`);
                
                if (result) {
                    // Check if this might be a navigation command
                    const text = intent.originalText.toLowerCase();
                    const isNavigationCommand = text.includes('go to') || text.includes('goto') || 
                                              text.includes('parent') || text.includes('function') || 
                                              text.includes('class') || text.includes('navigate') ||
                                              text.includes('move to') || text.includes('jump to') ||
                                              text.includes('explorer') || text.includes('editor') ||
                                              text.includes('terminal') || text.includes('panel');
                    
                    if (isNavigationCommand) {
                        log(`[ConversationalASR] CommandRouter handled navigation command`);
                        return 'navigation';
                    } else {
                        log(`[ConversationalASR] CommandRouter handled command successfully`);
                        return true;
                    }
                }
            } catch (routerError) {
                logError(`[ConversationalASR] CommandRouter failed: ${routerError}`);
            }
            
            // Map common intents to commands
            const text = intent.originalText.toLowerCase();
            
            // Check for image description commands first
            const imageKeywords = [
                '그림', '이미지', '사진', '차트', '그래프', '도표', '막대', '막대들', '색깔', '색상', 
                '개수', '몇 개', '몇 명', '텍스트', '글자', '문자', '숫자', '데이터', 
                '트렌드', '경향', '최대값', '최소값', '플롯', '바', '선', '점', '원',
                'picture', 'image', 'chart', 'graph', 'color', 'count', 'text', 'number', 
                'data', 'trend', 'bars', 'plot', 'bar', 'line', 'point', 'circle', 'png', 'jpg', 'jpeg'
            ];
            
            const hasImageKeyword = imageKeywords.some(keyword => text.includes(keyword));
            const isImageQuestion = text.includes('뭐가') || text.includes('어떻게') || 
                                  text.includes('몇') || text.includes('어떤') || 
                                  text.includes('다른지') || text.includes('같은지') || text.includes('다르니') ||
                                  text.includes('있어') || text.includes('있나') || text.includes('보여') || text.includes('보이') ||
                                  text.includes('what') || text.includes('how') || 
                                  text.includes('many') || text.includes('different') || text.includes('is there') || text.includes('are there');
            
            if (hasImageKeyword) {
                log(`[ConversationalASR] 🖼️ Image-related command detected: "${intent.originalText}"`);
                try {
                    // Just send the user's question directly to image analysis with LLM
                    const { findAndAnalyzeImageWithQuestion } = await import('./features/image_description.js');
                    await findAndAnalyzeImageWithQuestion(intent.originalText);
                    return true; // Command executed successfully
                } catch (error) {
                    log(`[ConversationalASR] Error executing image analysis: ${error}`);
                    return false;
                }
            }
            
            // Check for terminal explanation commands
            const terminalExplanationPatterns = [
                /터미널.*설명/i,
                /terminal.*explain/i,
                /터미널.*결과.*설명/i,
                /explain.*terminal.*output/i,
                /터미널.*출력.*설명/i,
                /설명.*터미널/i,
                /describe.*terminal/i
            ];
            
            const isTerminalExplanation = terminalExplanationPatterns.some(pattern => pattern.test(text));
            
            if (isTerminalExplanation) {
                log(`[ConversationalASR] 💻 Terminal explanation command detected: "${intent.originalText}"`);
                try {
                    await vscode.commands.executeCommand('lipcoder.explainTerminalOutput');
                    return true; // Command executed successfully
                } catch (error) {
                    log(`[ConversationalASR] Error executing terminal explanation: ${error}`);
                    return false;
                }
            }
            
            // Check for CSV file analysis commands
            const csvKeywords = [
                'csv', 'CSV', '파일', '설명', '분석', '구조', '컬럼', '데이터', '테이블',
                'file', 'analyze', 'describe', 'structure', 'column', 'table', 'explain', 'about'
            ];
            
            const hasCsvKeyword = csvKeywords.some(keyword => text.includes(keyword));
            const csvFileMatch = text.match(/([a-zA-Z0-9_-]+\.csv)/i);
            
            if (hasCsvKeyword && csvFileMatch) {
                const fileName = csvFileMatch[1];
                log(`[ConversationalASR] 📊 CSV file analysis command detected: "${intent.originalText}" for file: ${fileName}`);
                try {
                    // Execute CSV file analysis command
                    await vscode.commands.executeCommand('lipcoder.analyzeSpecificCSVFile', fileName);
                    return true; // Command executed successfully
                } catch (error) {
                    log(`[ConversationalASR] Error executing CSV analysis: ${error}`);
                    return false;
                }
            }
            
            // Handle panel navigation commands
            if (text.includes('explorer') || text.includes('file explorer')) {
                await vscode.commands.executeCommand('workbench.view.explorer');
                return 'navigation';
            } else if (text.includes('editor') && !text.includes('open')) {
                await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                return 'navigation';
            } else if (text.includes('terminal')) {
                await vscode.commands.executeCommand('workbench.action.terminal.focus');
                return 'navigation';
            } else if (text.includes('problems')) {
                await vscode.commands.executeCommand('workbench.actions.view.problems');
                return 'navigation';
            } else if (text.includes('output')) {
                await vscode.commands.executeCommand('workbench.action.output.toggleOutput');
                return 'navigation';
            }
            
            // Handle navigation commands that we can execute directly
            if (text.includes('go to line') || (text.includes('line') && /\d+/.test(text))) {
                const lineMatch = text.match(/\d+/);
                if (lineMatch) {
                    const lineNumber = parseInt(lineMatch[0]);
                    log(`[ConversationalASR] 🎯 Line navigation detected: going to line ${lineNumber}`);
                    
                    // Get the active editor with multiple fallbacks
                    let editor = vscode.window.activeTextEditor;
                    log(`[ConversationalASR] Active editor check: ${editor ? editor.document.fileName : 'none'}`);
                    log(`[ConversationalASR] Visible editors count: ${vscode.window.visibleTextEditors.length}`);
                    
                    // If no active editor, try visible editors
                    if (!editor && vscode.window.visibleTextEditors.length > 0) {
                        editor = vscode.window.visibleTextEditors[0];
                        log(`[ConversationalASR] No active editor, using first visible editor: ${editor.document.fileName}`);
                    }
                    
                    if (editor) {
                        // Navigate directly to the line (VS Code uses 0-based indexing)
                        const position = new vscode.Position(lineNumber - 1, 0);
                        editor.selection = new vscode.Selection(position, position);
                        editor.revealRange(new vscode.Range(position, position));
                        
                        log(`[ConversationalASR] ✅ Successfully navigated to line ${lineNumber} in ${editor.document.fileName}`);
                        return 'navigation'; // Special return value for navigation commands
                    } else {
                        log(`[ConversationalASR] ❌ No active editor found for line navigation`);
                        // Fallback to opening the dialog if no editor is active
                        await vscode.commands.executeCommand('workbench.action.gotoLine');
                        return 'navigation';
                    }
                }
            }
            
            // Handle "go to top" / "go to beginning" commands
            if (text.includes('go to top') || text.includes('go to beginning') || text.includes('go to start')) {
                log(`[ConversationalASR] 🎯 Go to top detected`);
                let editor = vscode.window.activeTextEditor;
                
                // If no active editor, try visible editors
                if (!editor && vscode.window.visibleTextEditors.length > 0) {
                    editor = vscode.window.visibleTextEditors[0];
                    log(`[ConversationalASR] No active editor for go to top, using first visible editor: ${editor.document.fileName}`);
                }
                
                if (editor) {
                    const position = new vscode.Position(0, 0);
                    editor.selection = new vscode.Selection(position, position);
                    editor.revealRange(new vscode.Range(position, position));
                    log(`[ConversationalASR] ✅ Successfully navigated to top of file`);
                    return 'navigation';
                }
            }
            
            if (text.includes('explorer') || text.includes('file tree')) {
                await vscode.commands.executeCommand('workbench.view.explorer');
                return true;
            }
            
            if (text.includes('terminal')) {
                await vscode.commands.executeCommand('workbench.action.terminal.new');
                return true;
            }
            
            if (text.includes('find') && text.includes('function')) {
                const functionMatch = text.match(/function\s+(\w+)/i);
                if (functionMatch) {
                    await vscode.commands.executeCommand('workbench.action.quickOpen', '@' + functionMatch[1]);
                    return true;
                }
            }
            
            // Handle file type opening requests before CommandRouter
            const fileTypeMatch = text.match(/(?:파이썬|python|자바스크립트|javascript|타입스크립트|typescript|제이슨|json|마크다운|markdown|텍스트|text|씨에스에스|css|에이치티엠엘|html|자바|java|씨플플|cpp|씨|c|쉘|shell)\s*파일\s*열어/i);
            if (fileTypeMatch || text.match(/open\s+(?:python|javascript|typescript|json|markdown|text|css|html|java|cpp|c|shell)\s+file/i)) {
                log(`[ConversationalASR] 📁 File type opening request detected: "${intent.originalText}"`);
                
                // Extract file type from intent parameters or text
                let fileType = intent.parameters?.fileType;
                if (!fileType) {
                    // Extract from text
                    const typeMap: { [key: string]: string } = {
                        '파이썬': 'python', 'python': 'python',
                        '자바스크립트': 'javascript', 'javascript': 'javascript',
                        '타입스크립트': 'typescript', 'typescript': 'typescript',
                        '제이슨': 'json', 'json': 'json',
                        '마크다운': 'markdown', 'markdown': 'markdown',
                        '텍스트': 'text', 'text': 'text',
                        '씨에스에스': 'css', 'css': 'css',
                        '에이치티엠엘': 'html', 'html': 'html',
                        '자바': 'java', 'java': 'java',
                        '씨플플': 'cpp', 'cpp': 'cpp',
                        '씨': 'c', 'c': 'c',
                        '쉘': 'shell', 'shell': 'shell'
                    };
                    
                    for (const [key, value] of Object.entries(typeMap)) {
                        if (text.includes(key)) {
                            fileType = value;
                            break;
                        }
                    }
                }
                
                if (fileType) {
                    try {
                        // Create CommandRouter with file type parameters
                        const commandRouter = new CommandRouter({ 
                            enableLogging: true,
                            showNotifications: true 
                        });
                        
                        // Create a modified text that CommandRouter can understand
                        const modifiedText = `open ${fileType} file`;
                        log(`[ConversationalASR] 📁 Routing file type request to CommandRouter: "${modifiedText}"`);
                        
                        const result = await commandRouter.processTranscription(modifiedText);
                        if (result) {
                            log(`[ConversationalASR] 📁 File type opening handled successfully`);
                            return true;
                        }
                    } catch (error) {
                        log(`[ConversationalASR] 📁 File type opening failed: ${error}`);
                    }
                }
            }
            
            // CommandRouter is now handled at the beginning of this function
            log(`[ConversationalASR] CommandRouter was already tried, falling back to specific command handling`);
            return false;
            
        } catch (error) {
            log(`[ConversationalASR] Command execution failed: ${error}`);
            return false;
        }
    }

    /**
     * Speak the response using TTS
     */
    private async speakResponse(response: string): Promise<void> {
        try {
            // Check if aborted before starting
            if (lineAbortController.signal.aborted) {
                log(`[ConversationalASR] Response speech aborted before starting`);
                return;
            }
            
            // Play a subtle notification sound first
            await playEarcon('suggestion');
            
            // Check again after earcon
            if (lineAbortController.signal.aborted) {
                log(`[ConversationalASR] Response speech aborted after earcon`);
                return;
            }
            
            // Check if this is a success message - use GPT voice for better feedback
            const isSuccessMessage = this.isSuccessMessage(response);
            
            if (isSuccessMessage) {
                // Use GPT voice for success messages with abort signal
                await speakGPT(response, lineAbortController.signal);
            } else {
                // Convert response to token chunks for TTS
                const chunks: TokenChunk[] = [{
                    tokens: [response],
                    category: 'comment' // Use comment voice for conversational responses
                }];
                
                await speakTokenList(chunks, lineAbortController.signal);
            }
        } catch (error) {
            if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted')) {
                log(`[ConversationalASR] Response speech aborted by user`);
                return;
            }
            logError(`[ConversationalASR] TTS error: ${error}`);
        }
    }

    /**
     * Check if a response is a success message that should use GPT voice
     */
    private isSuccessMessage(response: string): boolean {
        const successPatterns = [
            'saved', 'formatted', 'copied', 'pasted', 'deleted', 'closed', 'opened', 'done',
            'command executed successfully', 'executed successfully', 'completed successfully',
            'applied successfully', 'changes applied'
        ];
        
        const lowerResponse = response.toLowerCase();
        return successPatterns.some(pattern => lowerResponse.includes(pattern));
    }

    /**
     * Add text to conversation history
     */
    private addToHistory(text: string): void {
        this.conversationHistory.push({
            text,
            timestamp: Date.now()
        });
        
        // Keep only recent history
        if (this.conversationHistory.length > this.maxHistoryLength) {
            this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
        }
    }

    /**
     * Get recent conversation history as context
     */
    private getRecentHistory(): string {
        return this.conversationHistory
            .map(entry => `- "${entry.text}"`)
            .join('\n');
    }

    /**
     * Create error response
     */
    private createErrorResponse(originalText: string): ConversationalResponse {
        return {
            response: "Sorry, I had trouble understanding that. Could you try again?",
            actions: [
                {
                    id: 'retry',
                    label: 'Try Again',
                    description: 'Repeat your request',
                    command: 'retry',
                    parameters: { originalText },
                    icon: '$(refresh)'
                },
                {
                    id: 'help',
                    label: 'Help',
                    description: 'Show available commands',
                    command: 'showHelp',
                    icon: '$(question)'
                }
            ],
            shouldSpeak: true
        };
    }

    /**
     * Clear conversation history
     */
    clearHistory(): void {
        this.conversationHistory = [];
        log('[ConversationalASR] Conversation history cleared');
    }

    /**
     * Detect if the question is about files and should use bash script
     */
    private detectFileQuestion(text: string): { isFileQuestion: boolean; type: 'search' | 'open' | 'check'; filePattern?: string } {
        const lowerText = text.toLowerCase();
        
        // Patterns for opening specific files
        const openFilePatterns = [
            /open\s+([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/i,  // "open filename.py"
            /show\s+([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/i,  // "show filename.py"
            /edit\s+([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/i,  // "edit filename.py"
            /load\s+([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/i,  // "load filename.py"
            /^open([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)$/i,   // "openfilename.py" (concatenated)
            /^show([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)$/i,   // "showfilename.py" (concatenated)
            /^edit([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)$/i,   // "editfilename.py" (concatenated)
            /^load([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)$/i    // "loadfilename.py" (concatenated)
        ];
        
        for (const pattern of openFilePatterns) {
            const match = pattern.exec(text);
            if (match) {
                return { isFileQuestion: true, type: 'open', filePattern: match[1] };
            }
        }
        
        // Patterns for checking file existence by type
        const fileCheckPatterns = [
            /do we have.*?([a-zA-Z0-9]+)\s+file/i,
            /are there.*?([a-zA-Z0-9]+)\s+file/i,
            /find.*?([a-zA-Z0-9]+)\s+file/i,
            /check.*?([a-zA-Z0-9]+)\s+file/i,
            /any\s+([a-zA-Z0-9]+)\s+file/i,
            /what\s+([a-zA-Z0-9]+)\s+file/i,
            /show.*?([a-zA-Z0-9]+)\s+file/i,
            /list.*?([a-zA-Z0-9]+)\s+file/i,
            /([a-zA-Z0-9]+)\s+file.*?in.*?codebase/i,
            /([a-zA-Z0-9]+)\s+file.*?in.*?project/i
        ];
        
        for (const pattern of fileCheckPatterns) {
            const match = pattern.exec(text);
            if (match) {
                const fileType = match[1].toLowerCase();
                // Convert common file type names to extensions
                const extensionMap: { [key: string]: string } = {
                    'json': '*.json',
                    'python': '*.py',
                    'javascript': '*.js',
                    'typescript': '*.ts',
                    'csv': '*.csv',
                    'txt': '*.txt',
                    'md': '*.md',
                    'html': '*.html',
                    'css': '*.css',
                    'xml': '*.xml',
                    'yaml': '*.yaml',
                    'yml': '*.yml',
                    'config': '*config*',
                    'test': '*test*'
                };
                
                const searchPattern = extensionMap[fileType] || `*.${fileType}`;
                return { isFileQuestion: true, type: 'check', filePattern: searchPattern };
            }
        }
        
        return { isFileQuestion: false, type: 'search' };
    }

    /**
     * Handle file-related questions using bash script
     */
    private async handleFileQuestion(intent: ConversationalIntent, fileQuestion: { type: 'search' | 'open' | 'check'; filePattern?: string }): Promise<ConversationalResponse> {
        try {
            log(`[ConversationalASR] Handling file question with bash script: ${fileQuestion.type} - ${fileQuestion.filePattern}`);
            
            if (fileQuestion.type === 'open' && fileQuestion.filePattern) {
                // Handle file opening request
                return await this.handleFileOpenRequest(intent, fileQuestion.filePattern);
            } else if (fileQuestion.type === 'check' && fileQuestion.filePattern) {
                // Handle file existence check
                return await this.handleFileExistenceCheck(intent, fileQuestion.filePattern);
            }
            
            // Fallback to generic file search
            return await this.handleGenericFileSearch(intent);
            
        } catch (error) {
            logError(`[ConversationalASR] Error handling file question: ${error}`);
            return {
                response: `I encountered an error while checking for files: ${error}. Let me try a different approach.`,
                actions: [{
                    id: 'find_files',
                    label: 'Find Files',
                    description: 'Search for files by pattern',
                    command: 'findAnyFiles',
                    icon: '$(search)'
                }],
                shouldSpeak: true
            };
        }
    }

    /**
     * Handle file opening requests (e.g., "open university.py")
     */
    private async handleFileOpenRequest(intent: ConversationalIntent, fileName: string): Promise<ConversationalResponse> {
        try {
            log(`[ConversationalASR] Opening file: ${fileName}`);
            
            // Import the universal file checker
            const { findAndOpenFile } = require('./features/universal_file_checker');
            
            // Try to find and open the file
            const success = await findAndOpenFile(fileName);
            
            const actions: ConversationalAction[] = [];
            
            if (success) {
                actions.push({
                    id: 'analyze_file',
                    label: 'Analyze File',
                    description: 'Get detailed file analysis',
                    command: 'analyzeFile',
                    icon: '$(graph)'
                });
                
                return {
                    response: `Successfully opened ${fileName} in the editor.`,
                    actions,
                    shouldSpeak: false // Already spoke via findAndOpenFile
                };
            } else {
                actions.push({
                    id: 'search_similar',
                    label: 'Search Similar Files',
                    description: 'Find files with similar names',
                    command: 'findAnyFiles',
                    icon: '$(search)'
                });
                
                actions.push({
                    id: 'create_file',
                    label: 'Create File',
                    description: `Create ${fileName}`,
                    command: 'vibeCoding',
                    parameters: { instruction: `create a new file named ${fileName}` },
                    icon: '$(add)'
                });
                
                return {
                    response: `I couldn't find ${fileName}. Would you like me to search for similar files or create it?`,
                    actions,
                    shouldSpeak: false // Already spoke via findAndOpenFile
                };
            }
            
        } catch (error) {
            logError(`[ConversationalASR] Error opening file: ${error}`);
            return {
                response: `Error opening ${fileName}: ${error}`,
                actions: [],
                shouldSpeak: true
            };
        }
    }

    /**
     * Handle file existence checks (e.g., "do we have JSON files?")
     */
    private async handleFileExistenceCheck(intent: ConversationalIntent, pattern: string): Promise<ConversationalResponse> {
        try {
            log(`[ConversationalASR] Checking for files matching: ${pattern}`);
            
            // Import the universal file checker
            const { findFilesWithBash, generateFileReport, speakFileSearchResults } = require('./features/universal_file_checker');
            
            // Execute bash script to find files
            const searchResult = await findFilesWithBash(pattern);
            log(`[ConversationalASR] Found ${searchResult.files.length} files matching ${pattern} via bash`);
            
            // Generate report
            const report = await generateFileReport(searchResult);
            
            // Get file type for context
            const fileTypeForContext = pattern.replace('*.', '').replace('*', '').toUpperCase();
            
            // Store found files for follow-up questions
            this.lastFoundFiles = searchResult.files.map((file: any) => ({
                name: file.name,
                path: file.path,
                type: file.extension || 'unknown'
            }));
            this.lastOperationContext = `Found ${searchResult.files.length} ${fileTypeForContext} files`;
            
            // Speak the results immediately
            await speakFileSearchResults(searchResult);
            
            // Create actions based on results
            const actions: ConversationalAction[] = [];
            
            if (searchResult.files.length > 0) {
                actions.push({
                    id: 'show_file_report',
                    label: 'Show Full Report',
                    description: 'Display detailed file report',
                    command: 'findAnyFiles',
                    icon: '$(file-text)'
                });
                
                actions.push({
                    id: 'open_file',
                    label: 'Open File',
                    description: 'Open a specific file',
                    command: 'openFileByName',
                    icon: '$(go-to-file)'
                });
                
                actions.push({
                    id: 'analyze_file',
                    label: 'Analyze File',
                    description: 'Analyze a specific file',
                    command: 'analyzeFile',
                    icon: '$(graph)'
                });
            } else {
                const fileTypeForAction = pattern.replace('*.', '').replace('*', '');
                actions.push({
                    id: 'create_sample_file',
                    label: `Create Sample ${fileTypeForAction.toUpperCase()}`,
                    description: `Create a sample ${fileTypeForAction} file`,
                    command: 'vibeCoding',
                    parameters: { instruction: `create a sample ${fileTypeForAction} file` },
                    icon: '$(add)'
                });
                
                actions.push({
                    id: 'search_all_files',
                    label: 'Search All Files',
                    description: 'Search for any file type',
                    command: 'findAnyFiles',
                    icon: '$(search)'
                });
            }
            
            // Generate conversational response
            let response: string;
            const fileTypeForResponse = pattern.replace('*.', '').replace('*', '').toUpperCase();
            
            if (searchResult.files.length === 0) {
                response = `I checked the codebase using bash commands and found no ${fileTypeForResponse} files. Would you like me to create a sample ${fileTypeForResponse} file for you?`;
            } else if (searchResult.files.length === 1) {
                const file = searchResult.files[0];
                response = `Yes! I found 1 ${fileTypeForResponse} file: ${file.name} with ${file.lines} lines. It's located at ${vscode.workspace.asRelativePath(file.path)}.`;
            } else {
                const fileNames = searchResult.files.slice(0, 3).map((f: any) => f.name).join(', ');
                const moreText = searchResult.files.length > 3 ? ` and ${searchResult.files.length - 3} more` : '';
                response = `Yes! I found ${searchResult.files.length} ${fileTypeForResponse} files: ${fileNames}${moreText}. You can view the full report or analyze specific files.`;
            }
            
            return {
                response,
                actions,
                shouldSpeak: false // Already spoke via speakFileSearchResults
            };
            
        } catch (error) {
            logError(`[ConversationalASR] Error checking file existence: ${error}`);
            return {
                response: `I encountered an error while checking for files: ${error}. Let me try a different approach.`,
                actions: [{
                    id: 'find_files',
                    label: 'Find Files',
                    description: 'Search for files by pattern',
                    command: 'findAnyFiles',
                    icon: '$(search)'
                }],
                shouldSpeak: true
            };
        }
    }

    /**
     * Handle generic file search requests
     */
    private async handleGenericFileSearch(intent: ConversationalIntent): Promise<ConversationalResponse> {
        return {
            response: "I can help you search for files. What type of files are you looking for?",
            actions: [{
                id: 'find_any_files',
                label: 'Search Files',
                description: 'Search for files by pattern',
                command: 'findAnyFiles',
                icon: '$(search)'
            }, {
                id: 'open_file_by_name',
                label: 'Open File',
                description: 'Open a specific file by name',
                command: 'openFileByName',
                icon: '$(go-to-file)'
            }],
            shouldSpeak: true
        };
    }

    /**
     * Detect if the request should use LLM-generated bash script
     */
    private detectLLMBashRequest(text: string): { shouldUseLLM: boolean; complexity: 'simple' | 'complex'; query: string } {
        const lowerText = text.toLowerCase();
        
        // Patterns that indicate complex operations that would benefit from LLM-generated bash
        const complexPatterns = [
            /find.*large.*file/i,
            /count.*lines.*in.*all/i,
            /show.*file.*size/i,
            /list.*file.*by.*size/i,
            /find.*duplicate.*file/i,
            /search.*content.*in.*file/i,
            /find.*empty.*file/i,
            /show.*recent.*file/i,
            /find.*old.*file/i,
            /count.*file.*by.*type/i,
            /analyze.*file.*structure/i,
            /find.*file.*modified.*today/i,
            /show.*directory.*size/i,
            /find.*binary.*file/i,
            /list.*executable.*file/i
        ];
        
        // Patterns that indicate requests for custom operations
        const customOperationPatterns = [
            /how many.*file/i,
            /what.*the.*largest.*file/i,
            /which.*file.*contain/i,
            /show.*me.*all.*file.*that/i,
            /find.*file.*with.*more.*than/i,
            /list.*all.*file.*under/i,
            /count.*total.*lines/i,
            /what.*file.*type.*do.*we.*have/i,
            /analyze.*codebase/i,
            /summarize.*file/i
        ];
        
        // Check for complex patterns
        for (const pattern of complexPatterns) {
            if (pattern.test(text)) {
                return { shouldUseLLM: true, complexity: 'complex', query: text };
            }
        }
        
        // Check for custom operation patterns
        for (const pattern of customOperationPatterns) {
            if (pattern.test(text)) {
                return { shouldUseLLM: true, complexity: 'simple', query: text };
            }
        }
        
        return { shouldUseLLM: false, complexity: 'simple', query: text };
    }

    /**
     * Handle LLM bash script requests
     */
    private async handleLLMBashRequest(intent: ConversationalIntent, llmRequest: { complexity: 'simple' | 'complex'; query: string }): Promise<ConversationalResponse> {
        try {
            log(`[ConversationalASR] Handling LLM bash request: ${llmRequest.query}`);
            
            // Import the LLM bash generator
            const { processFileOperationRequest, speakBashResults, displayBashResults } = require('./features/llm_bash_generator');
            
            // Process the request with LLM-generated bash
            const result = await processFileOperationRequest(llmRequest.query);
            log(`[ConversationalASR] LLM bash script executed successfully`);
            
            // Store found files for follow-up questions if the output looks like file paths
            if (result.output && result.output.includes('./') && result.output.includes('.')) {
                const lines = result.output.split('\n').filter((line: string) => line.trim());
                this.lastFoundFiles = lines.map((line: string) => {
                    const filePath = line.split('|')[0] || line; // Handle format like "./file.json|size|lines"
                    return {
                        name: path.basename(filePath),
                        path: path.resolve(filePath),
                        type: path.extname(filePath) || 'unknown'
                    };
                }).filter((file: any) => file.name.includes('.')); // Only keep actual files
                this.lastOperationContext = `Found ${this.lastFoundFiles.length} files via LLM bash script`;
            }
            
            // Display results
            await displayBashResults(result, llmRequest.query);
            
            // Speak the results immediately
            await speakBashResults(result);
            
            // Create actions based on results
            const actions: ConversationalAction[] = [];
            
            if (result.output && !result.error) {
                actions.push({
                    id: 'generate_another_script',
                    label: 'Generate Another Script',
                    description: 'Create another bash script',
                    command: 'generateBashScript',
                    icon: '$(terminal)'
                });
                
                actions.push({
                    id: 'preview_script',
                    label: 'Preview Script',
                    description: 'Generate script without executing',
                    command: 'previewBashScript',
                    icon: '$(eye)'
                });
                
                // If results look like files, offer to open them
                if (result.output.includes('.') && result.output.includes('/')) {
                    actions.push({
                        id: 'open_file_from_results',
                        label: 'Open File',
                        description: 'Open a file from the results',
                        command: 'openFileByName',
                        icon: '$(go-to-file)'
                    });
                }
            } else if (result.error) {
                actions.push({
                    id: 'try_different_approach',
                    label: 'Try Different Approach',
                    description: 'Generate a different script',
                    command: 'generateBashScript',
                    icon: '$(refresh)'
                });
                
                actions.push({
                    id: 'manual_search',
                    label: 'Manual Search',
                    description: 'Use manual file search instead',
                    command: 'findAnyFiles',
                    icon: '$(search)'
                });
            }
            
            // Generate conversational response
            let response: string;
            
            if (result.error) {
                response = `I generated and executed a bash script for "${llmRequest.query}", but it encountered an error: ${result.error}. Would you like me to try a different approach?`;
            } else if (result.output) {
                const lines = result.output.split('\n').filter((line: string) => line.trim());
                if (lines.length === 0) {
                    response = `I executed the bash script successfully, but found no results for "${llmRequest.query}". The operation completed without errors.`;
                } else {
                    response = `I generated and executed a bash script for "${llmRequest.query}" and found ${lines.length} result${lines.length > 1 ? 's' : ''}. The script was: ${result.script}`;
                }
            } else {
                response = `I generated and executed a bash script for "${llmRequest.query}". The script completed successfully: ${result.script}`;
            }
            
            return {
                response,
                actions,
                shouldSpeak: false // Already spoke via speakBashResults
            };
            
        } catch (error) {
            logError(`[ConversationalASR] Error handling LLM bash request: ${error}`);
            return {
                response: `I encountered an error while generating a bash script for "${llmRequest.query}": ${error}. Let me try a simpler approach.`,
                actions: [{
                    id: 'fallback_search',
                    label: 'Simple File Search',
                    description: 'Use basic file search instead',
                    command: 'findAnyFiles',
                    icon: '$(search)'
                }, {
                    id: 'try_again',
                    label: 'Try Again',
                    description: 'Retry with LLM bash generation',
                    command: 'generateBashScript',
                    icon: '$(refresh)'
                }],
                shouldSpeak: true
            };
        }
    }

    /**
     * Detect if the question is a follow-up about recently found files
     */
    private detectFileFollowUpQuestion(text: string): { isFollowUp: boolean; questionType: 'content' | 'structure' | 'details' | 'open'; targetFile?: string } {
        if (this.lastFoundFiles.length === 0) {
            return { isFollowUp: false, questionType: 'content' };
        }
        
        const lowerText = text.toLowerCase();
        
        // Patterns for asking about file content
        const contentPatterns = [
            /how.*does.*that.*look.*like/i,
            /what.*does.*that.*contain/i,
            /show.*me.*that.*file/i,
            /what.*in.*that.*file/i,
            /how.*does.*it.*look/i,
            /what.*does.*it.*contain/i,
            /show.*me.*the.*content/i,
            /what.*inside.*that/i,
            /describe.*that.*file/i,
            /tell.*me.*about.*that.*file/i
        ];
        
        // Patterns for asking about file structure
        const structurePatterns = [
            /what.*structure.*does.*it.*have/i,
            /how.*is.*it.*structured/i,
            /what.*format.*is.*it/i,
            /what.*schema.*does.*it.*have/i,
            /analyze.*that.*file/i,
            /what.*fields.*does.*it.*have/i
        ];
        
        // Patterns for asking for more details
        const detailPatterns = [
            /tell.*me.*more.*about.*it/i,
            /give.*me.*details/i,
            /what.*else.*can.*you.*tell.*me/i,
            /more.*information.*about.*that/i
        ];
        
        // Patterns for opening files
        const openPatterns = [
            /open.*that.*file/i,
            /show.*it.*in.*editor/i,
            /edit.*that.*file/i,
            /load.*that.*file/i
        ];
        
        // Check for specific file references
        const fileNameMatch = this.lastFoundFiles.find(file => 
            lowerText.includes(file.name.toLowerCase()) || 
            lowerText.includes(file.name.toLowerCase().replace(/\.[^/.]+$/, ""))
        );
        
        // Check patterns
        for (const pattern of contentPatterns) {
            if (pattern.test(text)) {
                return { 
                    isFollowUp: true, 
                    questionType: 'content',
                    targetFile: fileNameMatch?.name
                };
            }
        }
        
        for (const pattern of structurePatterns) {
            if (pattern.test(text)) {
                return { 
                    isFollowUp: true, 
                    questionType: 'structure',
                    targetFile: fileNameMatch?.name
                };
            }
        }
        
        for (const pattern of detailPatterns) {
            if (pattern.test(text)) {
                return { 
                    isFollowUp: true, 
                    questionType: 'details',
                    targetFile: fileNameMatch?.name
                };
            }
        }
        
        for (const pattern of openPatterns) {
            if (pattern.test(text)) {
                return { 
                    isFollowUp: true, 
                    questionType: 'open',
                    targetFile: fileNameMatch?.name
                };
            }
        }
        
        return { isFollowUp: false, questionType: 'content' };
    }

    /**
     * Handle follow-up questions about recently found files
     */
    private async handleFileFollowUpQuestion(intent: ConversationalIntent, followUp: { questionType: 'content' | 'structure' | 'details' | 'open'; targetFile?: string }): Promise<ConversationalResponse> {
        try {
            log(`[ConversationalASR] Handling file follow-up question: ${followUp.questionType} for ${followUp.targetFile || 'recent files'}`);
            
            // Determine which file to examine
            let targetFile = this.lastFoundFiles[0]; // Default to first found file
            
            if (followUp.targetFile) {
                const specificFile = this.lastFoundFiles.find(file => 
                    file.name.toLowerCase().includes(followUp.targetFile!.toLowerCase())
                );
                if (specificFile) {
                    targetFile = specificFile;
                }
            }
            
            if (!targetFile) {
                return {
                    response: "I don't have any recent file information to reference. Could you specify which file you're asking about?",
                    actions: [{
                        id: 'find_files',
                        label: 'Find Files',
                        description: 'Search for files first',
                        command: 'findAnyFiles',
                        icon: '$(search)'
                    }],
                    shouldSpeak: true
                };
            }
            
            if (followUp.questionType === 'open') {
                // Handle file opening
                const { findAndOpenFile } = require('./features/universal_file_checker');
                const success = await findAndOpenFile(targetFile.name);
                
                return {
                    response: success ? 
                        `Opened ${targetFile.name} in the editor.` : 
                        `Could not open ${targetFile.name}. The file might have been moved or deleted.`,
                    actions: [{
                        id: 'analyze_opened_file',
                        label: 'Analyze File',
                        description: 'Analyze the opened file',
                        command: 'analyzeFile',
                        icon: '$(graph)'
                    }],
                    shouldSpeak: false // Already handled by findAndOpenFile
                };
            }
            
            // For content/structure/details questions, examine the file with LLM
            return await this.examineFileWithLLM(targetFile, followUp.questionType, intent.originalText);
            
        } catch (error) {
            logError(`[ConversationalASR] Error handling file follow-up: ${error}`);
            return {
                response: `I encountered an error while examining the file: ${error}`,
                actions: [{
                    id: 'try_again',
                    label: 'Try Again',
                    description: 'Retry file examination',
                    command: 'analyzeFile',
                    icon: '$(refresh)'
                }],
                shouldSpeak: true
            };
        }
    }

    /**
     * Examine file content using LLM and provide detailed analysis
     */
    private async examineFileWithLLM(file: {name: string, path: string, type: string}, questionType: 'content' | 'structure' | 'details', originalQuestion: string): Promise<ConversationalResponse> {
        try {
            log(`[ConversationalASR] Examining file with LLM: ${file.name} (${questionType})`);
            
            // Read file content
            const fs = require('fs').promises;
            let fileContent: string;
            
            try {
                fileContent = await fs.readFile(file.path, 'utf8');
            } catch (readError) {
                return {
                    response: `I couldn't read the file ${file.name}. It might be too large, binary, or have been moved.`,
                    actions: [{
                        id: 'try_open_file',
                        label: 'Try Opening File',
                        description: 'Attempt to open the file in editor',
                        command: 'openFileByName',
                        icon: '$(go-to-file)'
                    }],
                    shouldSpeak: true
                };
            }
            
            // Limit content size for LLM processing
            const maxContentLength = 4000;
            const truncatedContent = fileContent.length > maxContentLength ? 
                fileContent.substring(0, maxContentLength) + '\n... (truncated)' : 
                fileContent;
            
            // Generate LLM prompt based on question type and file type
            const client = getOpenAIClient();
            if (!client) {
                throw new Error('OpenAI client not available');
            }
            
            let systemPrompt = '';
            let userPrompt = '';
            
            if (file.type === '.json') {
                systemPrompt = `You are analyzing a JSON file. Provide a clear, conversational explanation of the file's content and structure. Focus on:
- What type of data it contains
- The main structure and fields
- Any interesting patterns or notable content
- Keep it conversational and easy to understand`;
                
                userPrompt = `The user asked: "${originalQuestion}"

Here's the JSON file "${file.name}":
\`\`\`json
${truncatedContent}
\`\`\`

Please explain what this JSON file contains and how it's structured in a conversational way.`;
            } else if (file.type === '.csv') {
                systemPrompt = `You are analyzing a CSV file. Explain the data structure, columns, and content in a conversational way.`;
                
                userPrompt = `The user asked: "${originalQuestion}"

Here's the CSV file "${file.name}":
\`\`\`csv
${truncatedContent}
\`\`\`

Please explain what this CSV contains and its structure.`;
            } else {
                systemPrompt = `You are analyzing a code/text file. Explain its purpose, structure, and content in a conversational way.`;
                
                userPrompt = `The user asked: "${originalQuestion}"

Here's the file "${file.name}":
\`\`\`
${truncatedContent}
\`\`\`

Please explain what this file contains and its purpose.`;
            }
            
            const completion = await client.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 500,
                temperature: 0.3
            });
            
            const analysis = completion.choices[0]?.message?.content?.trim() || 'Unable to analyze the file content.';
            
            // Create actions
            const actions: ConversationalAction[] = [
                {
                    id: 'open_file',
                    label: 'Open in Editor',
                    description: `Open ${file.name} in editor`,
                    command: 'openFileByName',
                    icon: '$(go-to-file)'
                },
                {
                    id: 'analyze_more',
                    label: 'Analyze More Files',
                    description: 'Analyze other found files',
                    command: 'analyzeFile',
                    icon: '$(graph)'
                }
            ];
            
            // Add file-type specific actions
            if (file.type === '.json') {
                actions.push({
                    id: 'create_json_function',
                    label: 'Create JSON Parser',
                    description: 'Generate code to parse this JSON',
                    command: 'vibeCoding',
                    parameters: { instruction: `create a TypeScript function to parse and work with the JSON structure from ${file.name}` },
                    icon: '$(add)'
                });
            }
            
            return {
                response: analysis,
                actions,
                shouldSpeak: true
            };
            
        } catch (error) {
            logError(`[ConversationalASR] Error examining file with LLM: ${error}`);
            return {
                response: `I encountered an error while analyzing ${file.name}: ${error}`,
                actions: [{
                    id: 'try_simple_analysis',
                    label: 'Simple Analysis',
                    description: 'Try basic file analysis instead',
                    command: 'analyzeFile',
                    icon: '$(file-text)'
                }],
                shouldSpeak: true
            };
        }
    }
}

// Global instance
let globalConversationalProcessor: ConversationalASRProcessor | null = null;

/**
 * Get or create the global conversational processor
 */
export function getConversationalProcessor(): ConversationalASRProcessor {
    if (!globalConversationalProcessor) {
        globalConversationalProcessor = new ConversationalASRProcessor();
    }
    return globalConversationalProcessor;
}

/**
 * Process ASR transcription through conversational flow
 */
export async function processConversationalASR(transcriptionText: string, context?: {mode?: 'command' | 'write'}): Promise<ConversationalResponse> {
    const processor = getConversationalProcessor();
    return await processor.processTranscription(transcriptionText, context);
}
