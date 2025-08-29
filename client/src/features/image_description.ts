import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { log, logError, logSuccess } from '../utils';
import { getOpenAIClient } from '../llm';
import { speakGPT, speakTokenList, TokenChunk } from '../audio';
import { logFeatureUsage } from '../activity_logger';
import { lineAbortController } from './stop_reading';

/**
 * Image description feature for accessibility
 * Uses GPT-4V to analyze images and provide detailed descriptions
 */

// Track if image description is currently active
let imageDescriptionActive = false;

export function getImageDescriptionActive(): boolean {
    return imageDescriptionActive;
}

export function setImageDescriptionActive(active: boolean): void {
    imageDescriptionActive = active;
}

/**
 * Speak image description with natural reading style
 * Uses a slower, more natural pace suitable for long descriptions
 */
export async function speakImageDescription(text: string, signal?: AbortSignal): Promise<void> {
    try {
        setImageDescriptionActive(true);
        log(`[ImageDescription] Speaking description with natural reading style`);
        
        // Use the global line abort controller if no signal provided
        const abortSignal = signal || lineAbortController.signal;
        
        // Split long text into smaller chunks for better pacing
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
        
        for (let i = 0; i < sentences.length; i++) {
            if (abortSignal?.aborted) {
                log(`[ImageDescription] Speech aborted by user`);
                return;
            }
            
            const sentence = sentences[i].trim();
            if (sentence.length === 0) continue;
            
            // Add punctuation back if it was removed
            const finalSentence = sentence + (i < sentences.length - 1 ? '.' : '');
            
            // Use vibe_text category for natural GPT voice
            const chunks: TokenChunk[] = [{
                tokens: [finalSentence],
                category: 'vibe_text', // Natural reading voice
                panning: undefined
            }];
            
            await speakTokenList(chunks, abortSignal);
            
            // Check again after speaking each sentence
            if (abortSignal?.aborted) {
                log(`[ImageDescription] Speech aborted after sentence ${i + 1}`);
                return;
            }
            
            // Add small pause between sentences for better comprehension
            if (i < sentences.length - 1) {
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(resolve, 300);
                    if (abortSignal) {
                        abortSignal.addEventListener('abort', () => {
                            clearTimeout(timeout);
                            reject(new Error('Aborted'));
                        });
                    }
                });
            }
        }
        
        log(`[ImageDescription] Finished speaking description`);
    } catch (error) {
        if (error instanceof Error && error.message === 'Aborted') {
            log(`[ImageDescription] Speech interrupted by user`);
            return;
        }
        logError(`[ImageDescription] Error speaking description: ${error}`);
        // Fallback to regular speakGPT
        await speakGPT(text, signal);
    } finally {
        setImageDescriptionActive(false);
    }
}

export interface ImageAnalysisResult {
    description: string;
    details: string[];
    accessibility_notes: string[];
}

/**
 * Analyze an image using GPT-4V with a specific question
 */
export async function analyzeImageWithQuestion(imagePath: string, questionText: string, signal?: AbortSignal): Promise<ImageAnalysisResult | null> {
    try {
        log(`[ImageDescription] Analyzing image with question: ${imagePath}, question: "${questionText}"`);
        
        // Check if file exists
        if (!fs.existsSync(imagePath)) {
            logError(`[ImageDescription] Image file not found: ${imagePath}`);
            return null;
        }

        // Read image file and convert to base64
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = getMimeType(imagePath);
        
        if (!mimeType) {
            logError(`[ImageDescription] Unsupported image format: ${imagePath}`);
            return null;
        }

        const client = getOpenAIClient();
        
        const prompt = `사용자 질문: "${questionText}"

이미지를 보고 위 질문에 대해 정확하고 직접적으로 답변해주세요. 

- 예/아니오 질문이면 먼저 명확하게 답하고 근거를 설명하세요
- 구체적인 정보를 묻는 질문이면 정확한 정보를 제공하세요
- 한국어로 자연스럽게 답변해주세요`;

        // Check if aborted before making API call
        if (signal?.aborted) {
            log(`[ImageDescription] Analysis aborted before GPT API call`);
            return null;
        }

        const response = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: prompt
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimeType};base64,${base64Image}`,
                                detail: "high"
                            }
                        }
                    ]
                }
            ],
            max_tokens: 1500,
            temperature: 0.3
        }, {
            signal: signal // Pass abort signal to OpenAI API
        });

        const description = response.choices[0]?.message?.content;
        
        if (!description) {
            logError('[ImageDescription] No description received from GPT');
            return null;
        }

        log(`[ImageDescription] Successfully analyzed image with question`);
        
        // Parse the response into structured format
        const lines = description.split('\n').filter(line => line.trim());
        const result: ImageAnalysisResult = {
            description: description,
            details: [],
            accessibility_notes: []
        };

        return result;

    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            log(`[ImageDescription] Image analysis aborted by user`);
            return null;
        }
        logError(`[ImageDescription] Error analyzing image with question: ${error}`);
        return null;
    }
}

/**
 * Analyze an image using GPT-4V and return detailed description
 */
export async function analyzeImageWithGPT(imagePath: string, signal?: AbortSignal): Promise<ImageAnalysisResult | null> {
    try {
        log(`[ImageDescription] Analyzing image: ${imagePath}`);
        
        // Check if file exists
        if (!fs.existsSync(imagePath)) {
            logError(`[ImageDescription] Image file not found: ${imagePath}`);
            return null;
        }

        // Read image file and convert to base64
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = getMimeType(imagePath);
        
        if (!mimeType) {
            logError(`[ImageDescription] Unsupported image format: ${imagePath}`);
            return null;
        }

        const client = getOpenAIClient();
        
        const prompt = `시각장애인을 위한 이미지 설명을 제공해주세요. 다음과 같은 형식으로 자세하고 체계적으로 설명해주세요:

1. **전체적인 개요**: 이미지의 주요 내용과 전반적인 분위기

2. **구체적인 세부사항**: 
   - 사람이나 객체의 위치, 크기, 색상 (예: "왼쪽에 빨간색 막대, 오른쪽에 파란색 막대")
   - 배경과 환경
   - 텍스트나 기호가 있다면 정확히 읽어주기
   - 숫자나 수치가 있다면 정확한 값 제공
   - 색상의 차이와 패턴 (예: "각 막대의 색이 서로 다름")
   - 개수와 수량 (예: "총 5개의 항목이 있음")
   - 크기와 비율의 차이

3. **차트나 그래프인 경우**:
   - 데이터의 트렌드와 경향
   - 최대값, 최소값
   - 비교 관계와 상대적 크기

4. **접근성 관련 정보**:
   - 중요한 시각적 정보
   - 감정이나 분위기
   - 맥락적 정보

특히 색상, 위치, 크기, 개수, 패턴, 텍스트 내용 등을 구체적으로 설명해주세요. 
한국어로 자연스럽고 이해하기 쉽게 설명해주세요. 시각장애인이 이미지의 내용을 완전히 이해할 수 있도록 충분히 자세하게 설명해주세요.`;

        // Check if aborted before making API call
        if (signal?.aborted) {
            log(`[ImageDescription] Analysis aborted before GPT API call`);
            return null;
        }

        const response = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: prompt
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimeType};base64,${base64Image}`,
                                detail: "high"
                            }
                        }
                    ]
                }
            ],
            max_tokens: 1500,
            temperature: 0.3
        }, {
            signal: signal // Pass abort signal to OpenAI API
        });

        const description = response.choices[0]?.message?.content;
        
        if (!description) {
            logError('[ImageDescription] No description received from GPT');
            return null;
        }

        log(`[ImageDescription] Successfully analyzed image`);
        
        // Parse the response into structured format
        const lines = description.split('\n').filter(line => line.trim());
        const result: ImageAnalysisResult = {
            description: description,
            details: [],
            accessibility_notes: []
        };

        // Extract structured information if possible
        let currentSection = '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.includes('세부사항') || trimmed.includes('구체적')) {
                currentSection = 'details';
            } else if (trimmed.includes('접근성') || trimmed.includes('시각적')) {
                currentSection = 'accessibility';
            } else if (trimmed.startsWith('-') || trimmed.startsWith('•')) {
                if (currentSection === 'details') {
                    result.details.push(trimmed.substring(1).trim());
                } else if (currentSection === 'accessibility') {
                    result.accessibility_notes.push(trimmed.substring(1).trim());
                }
            }
        }

        return result;

    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            log(`[ImageDescription] Image analysis aborted by user`);
            return null;
        }
        logError(`[ImageDescription] Error analyzing image: ${error}`);
        return null;
    }
}

/**
 * Get MIME type for image file
 */
function getMimeType(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.png':
            return 'image/png';
        case '.gif':
            return 'image/gif';
        case '.webp':
            return 'image/webp';
        case '.bmp':
            return 'image/bmp';
        case '.svg':
            return 'image/svg+xml';
        case '.tiff':
        case '.tif':
            return 'image/tiff';
        case '.ico':
            return 'image/x-icon';
        default:
            return null;
    }
}

/**
 * Find image files in the current workspace
 */
export async function findImageFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return [];
    }

    const imageFiles: string[] = [];

    for (const folder of workspaceFolders) {
        // Search for common image file extensions
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, '**/*.{jpg,jpeg,png,gif,webp,bmp,svg,tiff,tif,ico}'),
            '**/node_modules/**',
            100 // Limit to 100 files
        );
        
        imageFiles.push(...files.map(file => file.fsPath));
    }

    // Sort by file name for consistent ordering
    return imageFiles.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

/**
 * Analyze currently open image file or auto-open single image file
 */
export async function selectAndAnalyzeImage(): Promise<void> {
    try {
        logFeatureUsage('image_description', 'select');
        
        // First check if current active editor has an image file
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const currentFilePath = activeEditor.document.uri.fsPath;
            const mimeType = getMimeType(currentFilePath);
            
            if (mimeType) {
                // Current file is an image, analyze it directly
                log(`[ImageDescription] Analyzing currently open image: ${currentFilePath}`);
                await analyzeSelectedImage(currentFilePath);
                return;
            }
        }
        
        // Also check if there's an active tab with an image file (for image preview)
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (activeTab && activeTab.input) {
            try {
                const tabInput = activeTab.input as any;
                if (tabInput && tabInput.uri) {
                    const tabUri = tabInput.uri as vscode.Uri;
                    const tabFilePath = tabUri.fsPath;
                    const mimeType = getMimeType(tabFilePath);
                    
                    if (mimeType) {
                        log(`[ImageDescription] Analyzing image from active tab: ${tabFilePath}`);
                        await analyzeSelectedImage(tabFilePath);
                        return;
                    }
                }
            } catch (error) {
                // Ignore tab input errors and continue to file selection
                log(`[ImageDescription] Could not get tab input: ${error}`);
            }
        }
        
        // No image file is currently open, find image files in workspace
        const imageFiles = await findImageFiles();
        
        if (imageFiles.length === 0) {
            vscode.window.showInformationMessage('워크스페이스에서 이미지 파일을 찾을 수 없습니다.');
            await speakGPT('워크스페이스에서 이미지 파일을 찾을 수 없습니다.');
            return;
        }

        // If there's only one image file, automatically open and analyze it
        if (imageFiles.length === 1) {
            const singleImagePath = imageFiles[0];
            const fileName = path.basename(singleImagePath);
            log(`[ImageDescription] Found single image file, auto-opening: ${singleImagePath}`);
            
            // Notify user about auto-opening
            vscode.window.showInformationMessage(`이미지 파일 ${fileName}을 자동으로 열어서 분석합니다.`, { modal: false });
            await speakGPT(`${fileName} 파일을 자동으로 열어서 분석하겠습니다.`);
            
            try {
                // Open the image file in VS Code
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(singleImagePath));
                await vscode.window.showTextDocument(document);
                
                // Analyze the image
                await analyzeSelectedImage(singleImagePath);
                return;
            } catch (error) {
                log(`[ImageDescription] Could not open image file in editor, analyzing directly: ${error}`);
                // If opening fails, just analyze the image directly
                await analyzeSelectedImage(singleImagePath);
                return;
            }
        }

        // Multiple image files found, show selection dialog
        const quickPickItems = imageFiles.map(filePath => ({
            label: path.basename(filePath),
            description: path.dirname(filePath),
            filePath: filePath
        }));

        // Show file selection dialog
        const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
            placeHolder: '분석할 이미지 파일을 선택하세요 (총 ' + imageFiles.length + '개 파일)',
            matchOnDescription: true
        });

        if (!selectedItem) {
            return;
        }

        // Open the selected image file and analyze it
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selectedItem.filePath));
            await vscode.window.showTextDocument(document);
        } catch (error) {
            log(`[ImageDescription] Could not open selected image file in editor: ${error}`);
            // Continue with analysis even if opening fails
        }

        await analyzeSelectedImage(selectedItem.filePath);

    } catch (error) {
        logError(`[ImageDescription] Error in selectAndAnalyzeImage: ${error}`);
        await speakGPT('이미지 선택 중 오류가 발생했습니다.');
    }
}

/**
 * Analyze image with a specific question and speak the answer
 */
export async function analyzeImageWithQuestionAndSpeak(imagePath: string, questionText: string): Promise<void> {
    try {
        logFeatureUsage('image_description', 'analyze_with_question');
        
        // Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "이미지 질문 분석 중...",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "GPT로 이미지 질문 분석 중..." });
            
            const result = await analyzeImageWithQuestion(imagePath, questionText, lineAbortController.signal);
            
            if (!result) {
                throw new Error('이미지 질문 분석에 실패했습니다.');
            }

            progress.report({ increment: 50, message: "답변 생성 완료, 음성으로 읽어드립니다..." });
            
            // Speak the answer using natural reading TTS
            const fileName = path.basename(imagePath);
            const introText = `${fileName} 파일에 대한 질문 "${questionText}"의 답변입니다.`;
            
            // First speak the intro
            await speakGPT(introText, lineAbortController.signal);
            
            // Then speak the detailed answer with natural reading style
            await speakImageDescription(result.description, lineAbortController.signal);
            
            progress.report({ increment: 100, message: "완료" });
            
            logSuccess(`[ImageDescription] Successfully analyzed and spoke answer for question: "${questionText}" on image: ${imagePath}`);
        });

    } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted')) {
            log(`[ImageDescription] Image question analysis aborted by user`);
            await speakGPT('이미지 질문 분석이 중단되었습니다.', lineAbortController.signal);
            return;
        }
        logError(`[ImageDescription] Error analyzing image with question: ${error}`);
        await speakGPT(`이미지 질문 분석 중 오류가 발생했습니다: ${error}`);
    }
}

/**
 * Find and analyze image with question - automatically finds the most relevant image
 */
export async function findAndAnalyzeImageWithQuestion(questionText: string): Promise<void> {
    try {
        logFeatureUsage('image_description', 'find_and_analyze_with_question');
        
        // First check if current active editor has an image file
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const currentFilePath = activeEditor.document.uri.fsPath;
            const mimeType = getMimeType(currentFilePath);
            
            if (mimeType) {
                // Current file is an image, analyze it directly
                log(`[ImageDescription] Analyzing currently open image with question: ${currentFilePath}`);
                await analyzeImageWithQuestionAndSpeak(currentFilePath, questionText);
                return;
            }
        }
        
        // Also check if there's an active tab with an image file (for image preview)
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (activeTab && activeTab.input) {
            try {
                const tabInput = activeTab.input as any;
                if (tabInput && tabInput.uri) {
                    const tabUri = tabInput.uri as vscode.Uri;
                    const tabFilePath = tabUri.fsPath;
                    const mimeType = getMimeType(tabFilePath);
                    
                    if (mimeType) {
                        log(`[ImageDescription] Analyzing image from active tab with question: ${tabFilePath}`);
                        await analyzeImageWithQuestionAndSpeak(tabFilePath, questionText);
                        return;
                    }
                }
            } catch (error) {
                // Ignore tab input errors and continue to file selection
                log(`[ImageDescription] Could not get tab input: ${error}`);
            }
        }
        
        // No image file is currently open, find image files in workspace
        const imageFiles = await findImageFiles();
        
        if (imageFiles.length === 0) {
            vscode.window.showInformationMessage('워크스페이스에서 이미지 파일을 찾을 수 없습니다.');
            await speakGPT('워크스페이스에서 이미지 파일을 찾을 수 없습니다.');
            return;
        }

        // If there's only one image file, automatically use it
        if (imageFiles.length === 1) {
            const singleImagePath = imageFiles[0];
            const fileName = path.basename(singleImagePath);
            log(`[ImageDescription] Found single image file, analyzing with question: ${singleImagePath}`);
            
            // Notify user about auto-selection
            vscode.window.showInformationMessage(`이미지 파일 ${fileName}에 대한 질문을 분석합니다.`, { modal: false });
            await speakGPT(`${fileName} 파일에 대한 질문을 분석하겠습니다.`);
            
            await analyzeImageWithQuestionAndSpeak(singleImagePath, questionText);
            return;
        }

        // Multiple image files found, use the most recently modified one
        // Sort by modification time (most recent first)
        const sortedImageFiles = await Promise.all(imageFiles.map(async (filePath) => {
            try {
                const stats = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
                return { filePath, mtime: stats.mtime };
            } catch (error) {
                return { filePath, mtime: 0 };
            }
        }));
        
        sortedImageFiles.sort((a, b) => b.mtime - a.mtime);
        const mostRecentImagePath = sortedImageFiles[0].filePath;
        const fileName = path.basename(mostRecentImagePath);
        
        log(`[ImageDescription] Using most recent image file for question: ${mostRecentImagePath}`);
        
        // Notify user about auto-selection
        vscode.window.showInformationMessage(`가장 최근 이미지 파일 ${fileName}에 대한 질문을 분석합니다.`, { modal: false });
        await speakGPT(`가장 최근 이미지 파일 ${fileName}에 대한 질문을 분석하겠습니다.`);
        
        await analyzeImageWithQuestionAndSpeak(mostRecentImagePath, questionText);

    } catch (error) {
        logError(`[ImageDescription] Error in findAndAnalyzeImageWithQuestion: ${error}`);
        await speakGPT('이미지 질문 분석 중 오류가 발생했습니다.');
    }
}

/**
 * Analyze the selected image and speak the description
 */
export async function analyzeSelectedImage(imagePath: string): Promise<void> {
    try {
        logFeatureUsage('image_description', 'analyze');
        
        // Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "이미지 분석 중...",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "GPT로 이미지 분석 중..." });
            
            const result = await analyzeImageWithGPT(imagePath, lineAbortController.signal);
            
            if (!result) {
                throw new Error('이미지 분석에 실패했습니다.');
            }

            progress.report({ increment: 50, message: "설명 생성 완료, 음성으로 읽어드립니다..." });
            
            // Speak the description using natural reading TTS
            const fileName = path.basename(imagePath);
            const introText = `${fileName} 파일의 이미지 설명입니다.`;
            
            // First speak the intro
            await speakGPT(introText, lineAbortController.signal);
            
            // Then speak the detailed description with natural reading style
            await speakImageDescription(result.description, lineAbortController.signal);
            
            progress.report({ increment: 100, message: "완료" });
            
            logSuccess(`[ImageDescription] Successfully analyzed and spoke description for: ${imagePath}`);
        });

    } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted')) {
            log(`[ImageDescription] Image analysis aborted by user`);
            await speakGPT('이미지 분석이 중단되었습니다.', lineAbortController.signal);
            return;
        }
        logError(`[ImageDescription] Error analyzing image: ${error}`);
        await speakGPT(`이미지 분석 중 오류가 발생했습니다: ${error}`);
    }
}

/**
 * Analyze image from file explorer context menu
 */
export async function analyzeImageFromExplorer(uri: vscode.Uri): Promise<void> {
    if (!uri) {
        return;
    }

    const filePath = uri.fsPath;
    const mimeType = getMimeType(filePath);
    
    if (!mimeType) {
        vscode.window.showErrorMessage('지원되지 않는 이미지 형식입니다.');
        return;
    }

    await analyzeSelectedImage(filePath);
}

/**
 * Register image description commands
 */
export function registerImageDescription(context: vscode.ExtensionContext): void {
    log('[ImageDescription] Registering image description commands');

    // Command to select and analyze image
    const selectCommand = vscode.commands.registerCommand(
        'lipcoder.selectAndAnalyzeImage',
        selectAndAnalyzeImage
    );

    // Command to analyze image from explorer context menu
    const analyzeFromExplorerCommand = vscode.commands.registerCommand(
        'lipcoder.analyzeImageFromExplorer',
        analyzeImageFromExplorer
    );

    context.subscriptions.push(selectCommand, analyzeFromExplorerCommand);
    
    logSuccess('[ImageDescription] Image description commands registered successfully');
}
