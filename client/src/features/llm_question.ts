import * as vscode from 'vscode';
import { speakTokenList, TokenChunk } from '../audio';
import { log, logError, logSuccess } from '../utils';
import { callLLMForCompletion } from '../llm';

interface LLMQuestionResult {
    question: string;
    answer: string;
    language: 'korean' | 'english';
}

/**
 * Main function to ask general questions to LLM and get speech-only responses
 */
export async function askLLMQuestion(question: string): Promise<void> {
    if (!question || !question.trim()) {
        await showAndSpeakResult({
            question: '',
            answer: "질문을 입력해주세요.",
            language: 'korean'
        });
        return;
    }

    try {
        log(`[LLMQuestion] Processing question: "${question}"`);
        
        // Analyze the question and generate response
        const result = await processLLMQuestion(question);
        
        // Show and speak the result (speech-only, non-blocking notification)
        await showAndSpeakResult(result);
        
    } catch (error) {
        logError(`[LLMQuestion] Error processing question: ${error}`);
        
        // Determine language for error message
        const isKorean = /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(question);
        const errorMessage = isKorean 
            ? `죄송합니다. 질문을 처리하는 중에 오류가 발생했습니다: ${error}`
            : `Sorry, I encountered an error while processing your question: ${error}`;
            
        await showAndSpeakResult({
            question,
            answer: errorMessage,
            language: isKorean ? 'korean' : 'english'
        });
    }
}

/**
 * Process the LLM question and generate response
 */
async function processLLMQuestion(question: string): Promise<LLMQuestionResult> {
    // Detect language of the question
    const isKorean = /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(question);
    const language: 'korean' | 'english' = isKorean ? 'korean' : 'english';
    
    // Create system prompt based on detected language
    const systemPrompt = isKorean 
        ? `당신은 도움이 되는 AI 어시스턴트입니다. 사용자의 질문에 대해 정확하고 유용한 답변을 한국어로 제공해주세요. 답변은 최대한 간결하고 핵심적인 내용만 포함해야 합니다. 1-2문장으로 요점만 말해주세요. 불필요한 설명이나 부가 정보는 생략하세요.`
        : `You are a helpful AI assistant. Please provide accurate and useful answers to the user's questions in English. Your responses must be extremely concise and to the point. Answer in 1-2 sentences maximum, focusing only on the essential information. Avoid unnecessary explanations or additional details.`;
    
    try {
        // Use the existing LLM completion function with appropriate parameters
        const answer = await callLLMForCompletion(
            systemPrompt,
            question,
            150, // max tokens - keep responses very concise
            0.1  // lower temperature for more focused responses
        );
        
        if (!answer || answer.trim() === '') {
            const fallbackAnswer = isKorean 
                ? "죄송합니다. 답변을 생성할 수 없었습니다."
                : "Sorry, I couldn't generate an answer.";
            
            return {
                question,
                answer: fallbackAnswer,
                language
            };
        }
        
        return {
            question,
            answer: answer.trim(),
            language
        };
        
    } catch (error) {
        logError(`[LLMQuestion] LLM completion failed: ${error}`);
        
        // Fallback response
        const fallbackAnswer = isKorean 
            ? "죄송합니다. 현재 답변을 생성할 수 없습니다. LLM 설정을 확인해주세요."
            : "Sorry, I can't generate an answer right now. Please check your LLM configuration.";
            
        return {
            question,
            answer: fallbackAnswer,
            language
        };
    }
}

/**
 * Show result in popup and speak it (speech-only, non-blocking)
 */
async function showAndSpeakResult(result: LLMQuestionResult): Promise<void> {
    const { question, answer, language } = result;
    
    // Show non-blocking notification popup (bottom-right corner) [[memory:6411078]]
    // Keep it simple and non-intrusive
    const shortAnswer = answer.length > 100 ? answer.substring(0, 97) + '...' : answer;
    vscode.window.showInformationMessage(`💬 ${shortAnswer}`);
    
    // Speak the full answer as plain text [[memory:6411078]]
    await speakLLMAnswer(answer);
    
    logSuccess(`[LLMQuestion] Question answered: "${question}" (${language})`);
}

/**
 * Convert LLM answer to speech using simple TTS [[memory:6411078]]
 */
async function speakLLMAnswer(answer: string): Promise<void> {
    try {
        log(`[LLMQuestion] Speaking answer: "${answer.substring(0, 100)}..."`);
        
        // Speak as simple plain text without code reading style [[memory:6411078]]
        const chunks: TokenChunk[] = [{
            tokens: [answer],
            category: undefined  // No category = plain text TTS
        }];
        
        await speakTokenList(chunks);
        
    } catch (error) {
        logError(`[LLMQuestion] Error speaking answer: ${error}`);
    }
}

/**
 * Register LLM question commands
 */
export function registerLLMQuestion(context: vscode.ExtensionContext) {
    // Register command for manual LLM questions
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.askLLMQuestion', async () => {
            const question = await vscode.window.showInputBox({
                placeHolder: 'Ask any question... (질문을 입력하세요...)',
                prompt: 'LLM Question: Ask about anything - coding, math, general knowledge, etc.',
                value: '',
                ignoreFocusOut: true
            });

            if (question) {
                await askLLMQuestion(question);
            }
        })
    );
    
    // Register test command for debugging
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.testLLMQuestion', async () => {
            // Test with a Korean question
            await askLLMQuestion('사인 함수가 뭐야?');
        })
    );
    
    logSuccess('[LLMQuestion] LLM question commands registered');
}
