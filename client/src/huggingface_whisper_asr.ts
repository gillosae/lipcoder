import * as vscode from 'vscode';
import { log, logError, logSuccess, logWarning } from './utils';
import { huggingFaceWhisperConfig } from './config';
// VAD disabled for Push-to-Talk mode
// import { detectVoiceActivity, createLenientVADConfig } from './utils/vad';

export interface HuggingFaceWhisperChunk {
    text: string;
    timestamp: number;
}

export interface HuggingFaceWhisperOptions {
    onTranscription?: (chunk: HuggingFaceWhisperChunk) => void;
    onError?: (error: Error) => void;
    onRecordingStart?: () => void;
    onRecordingStop?: () => void;
}

/**
 * Hugging Face Whisper ASR Client
 * Uses local Hugging Face Transformers Whisper model for speech recognition
 */
export class HuggingFaceWhisperClient {
    private options?: HuggingFaceWhisperOptions;
    private microphone: any = null;
    private audioStream: any = null;
    private audioBuffer: Buffer[] = [];
    private isRecording = false;
    private isProcessing = false;
    private disposed = false;
    private recordingStartTime = 0;
    private chunkTimer: NodeJS.Timeout | null = null;
    
    // Duplicate prevention
    private lastTranscriptionText = '';
    private lastTranscriptionTime = 0;

    constructor(options?: HuggingFaceWhisperOptions) {
        this.options = options;
        log('[HF-Whisper-ASR] Client initialized');
    }

    async startRecording(): Promise<void> {
        if (this.disposed) {
            throw new Error('HuggingFace Whisper ASR client has been disposed');
        }

        if (this.isRecording) {
            logWarning('[HF-Whisper-ASR] Already recording, stopping previous session first');
            await this.stopRecording();
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Force cleanup before starting
        await this.forceCleanup();

        try {
            log('[HF-Whisper-ASR] Starting recording...');
            this.recordingStartTime = Date.now();
            this.isRecording = true;
            this.isProcessing = false;
            this.lastTranscriptionText = '';
            this.lastTranscriptionTime = 0;

            // Initialize microphone
            const Microphone = require('node-microphone');
            
            log('[HF-Whisper-ASR] Creating microphone instance...');
            this.microphone = new Microphone({
                rate: huggingFaceWhisperConfig.sampleRate,
                channels: 1,
                debug: false,
                exitOnSilence: 6
            });

            // Clear audio buffer
            this.audioBuffer = [];
            this.recordingStartTime = Date.now();

            // Start recording and get audio stream
            log('[HF-Whisper-ASR] Starting microphone recording...');
            this.audioStream = this.microphone.startRecording();
            
            // Verify stream is valid
            if (!this.audioStream) {
                throw new Error('Hugging Face Whisper ASR failed to create audio stream');
            }

            // Clear any existing listeners
            this.audioStream.removeAllListeners('data');
            this.audioStream.removeAllListeners('error');

            this.audioStream.on('data', (chunk: Buffer) => {
                if (!this.disposed && this.isRecording) {
                    // 버퍼 크기 제한으로 메모리 누수 방지
                    if (this.audioBuffer.length > 1000) {
                        logWarning('[HF-Whisper-ASR] Audio buffer overflow, clearing old chunks');
                        this.audioBuffer = this.audioBuffer.slice(-500);
                    }
                    this.audioBuffer.push(chunk);
                }
            });

            this.audioStream.on('error', (error: Error) => {
                logError(`[HF-Whisper-ASR] Audio stream error: ${error}`);
                if (this.options?.onError) {
                    this.options.onError(error);
                }
            });

            // Push-to-Talk mode: No real-time processing
            // Audio will be processed only when stopRecording() is called
            log('[HF-Whisper-ASR] Push-to-Talk mode: Real-time processing disabled');

            // Notify recording started
            if (this.options?.onRecordingStart) {
                this.options.onRecordingStart();
            }

            logSuccess('[HF-Whisper-ASR] Recording started successfully');

        } catch (error) {
            this.isRecording = false;
            logError(`[HF-Whisper-ASR] Failed to start recording: ${error}`);
            throw error;
        }
    }

    async stopRecording(): Promise<void> {
        if (!this.isRecording) {
            log('[HF-Whisper-ASR] Not recording, nothing to stop');
            return;
        }

        try {
            log('[HF-Whisper-ASR] Stopping recording...');
            this.isRecording = false;

            // Clear chunk timer
            if (this.chunkTimer) {
                clearInterval(this.chunkTimer);
                this.chunkTimer = null;
            }

            // Stop microphone and audio stream
            if (this.microphone) {
                try {
                    if (typeof this.microphone.stopRecording === 'function') {
                        this.microphone.stopRecording();
                    }
                    if (typeof this.microphone.stop === 'function') {
                        this.microphone.stop();
                    }
                } catch (err) {
                    logError(`[HF-Whisper-ASR] Error stopping microphone: ${err}`);
                }
                this.microphone = null;
            }

            // Clean up audio stream
            if (this.audioStream) {
                try {
                    if (typeof this.audioStream.stop === 'function') {
                        this.audioStream.stop();
                    }
                } catch (err) {
                    logError(`[HF-Whisper-ASR] Error stopping audio stream: ${err}`);
                }
                this.audioStream = null;
            }

            // Process remaining audio buffer
            if (this.audioBuffer.length > 0 && !this.isProcessing) {
                await this.processAudioChunk();
            }

            // Notify recording stopped
            if (this.options?.onRecordingStop) {
                this.options.onRecordingStop();
            }

            logSuccess('[HF-Whisper-ASR] Recording stopped successfully');

        } catch (error) {
            logError(`[HF-Whisper-ASR] Error stopping recording: ${error}`);
            throw error;
        } finally {
            // 처리 완료 후 상태 정리
            log('[HF-Whisper-ASR] Stop recording completed');
        }
    }

    private async processAudioChunk(): Promise<void> {
        if (this.audioBuffer.length === 0 || this.disposed) {
            return;
        }

        // 이미 처리 중이면 잠시 대기 후 재시도
        if (this.isProcessing) {
            log('[HF-Whisper-ASR] Processing in progress, waiting...');
            await new Promise(resolve => setTimeout(resolve, 100));
            if (this.isProcessing) {
                logWarning('[HF-Whisper-ASR] Still processing after wait, skipping duplicate request');
                return;
            }
        }

        this.isProcessing = true;

        try {
            // Get current audio chunks
            const chunks = [...this.audioBuffer];
            this.audioBuffer = []; // Clear buffer

            if (chunks.length === 0) {
                return;
            }

            // Combine audio chunks
            const combinedAudio = Buffer.concat(chunks);
            log(`[HF-Whisper-ASR] Processing ${combinedAudio.length} bytes of audio`);

            // Convert to WAV format
            const wavBuffer = this.createWavFile(combinedAudio);

            // Send to Hugging Face Whisper server
            const transcription = await this.transcribeWithHuggingFace(wavBuffer);

            if (transcription) {
                // 중복 텍스트 인식 방지 (매우 관대한 설정)
                const currentTime = Date.now();
                const timeDiff = currentTime - this.lastTranscriptionTime;

                // 이전 인식 결과가 있을 때만 중복 체크
                if (this.lastTranscriptionText && this.lastTranscriptionTime > 0) {
                    const isExactMatch = transcription.trim() === this.lastTranscriptionText.trim();

                    logSuccess(`[HF-Whisper-ASR] 🔍 Duplicate check: current="${transcription}", last="${this.lastTranscriptionText}", timeDiff=${timeDiff}ms, exact=${isExactMatch}`);

                    // 매우 짧은 시간 내 완전히 같은 텍스트만 무시 (500ms 이내)
                    if (isExactMatch && timeDiff < 500) {
                        logWarning(`[HF-Whisper-ASR] ❌ Exact duplicate detected (${timeDiff}ms ago), skipping: "${transcription}"`);
                        return;
                    }
                } else {
                    logSuccess(`[HF-Whisper-ASR] 🔍 First transcription or reset state, processing: "${transcription}"`);
                }

                // 새로운 유효한 인식 결과
                this.lastTranscriptionText = transcription;
                this.lastTranscriptionTime = currentTime;

                const chunk: HuggingFaceWhisperChunk = {
                    text: transcription,
                    timestamp: this.recordingStartTime
                };

                log(`[HF-Whisper-ASR] ✅ Transcription result: "${transcription}"`);

                if (this.options?.onTranscription) {
                    this.options.onTranscription(chunk);
                }
            }

        } catch (error) {
            logError(`[HF-Whisper-ASR] Error processing audio chunk: ${error}`);
            if (this.options?.onError) {
                this.options.onError(error as Error);
            }
        } finally {
            this.isProcessing = false;
        }
    }



    private createWavFile(pcmData: Buffer): Buffer {
        // Push-to-Talk mode: Skip VAD and process all audio (user intentionally started recording)
        const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.length / 2);
        
        log(`[HF-Whisper-ASR] 🎤 Push-to-Talk mode: Creating WAV with all ${samples.length} samples (no VAD filtering)`);
        
        // Use all samples without VAD filtering
        const processedData = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
        
        const sampleRate = huggingFaceWhisperConfig.sampleRate;
        const numChannels = 1;
        const bitsPerSample = 16;
        const byteRate = sampleRate * numChannels * bitsPerSample / 8;
        const blockAlign = numChannels * bitsPerSample / 8;
        const dataSize = processedData.length;
        const fileSize = 36 + dataSize;

        const header = Buffer.alloc(44);
        let offset = 0;

        // RIFF header
        header.write('RIFF', offset); offset += 4;
        header.writeUInt32LE(fileSize, offset); offset += 4;
        header.write('WAVE', offset); offset += 4;

        // fmt chunk
        header.write('fmt ', offset); offset += 4;
        header.writeUInt32LE(16, offset); offset += 4; // fmt chunk size
        header.writeUInt16LE(1, offset); offset += 2; // PCM format
        header.writeUInt16LE(numChannels, offset); offset += 2;
        header.writeUInt32LE(sampleRate, offset); offset += 4;
        header.writeUInt32LE(byteRate, offset); offset += 4;
        header.writeUInt16LE(blockAlign, offset); offset += 2;
        header.writeUInt16LE(bitsPerSample, offset); offset += 2;

        // data chunk
        header.write('data', offset); offset += 4;
        header.writeUInt32LE(dataSize, offset);

        return Buffer.concat([header, processedData]);
    }

    private async transcribeWithHuggingFace(audioBuffer: Buffer): Promise<string | null> {
        try {
            log(`[HF-Whisper-ASR] Sending ${audioBuffer.length} bytes to Hugging Face Whisper server`);

            // Use dynamic import for fetch to handle ES modules
            const fetch = await import('node-fetch').then(module => module.default);
            const FormData = require('form-data');
            const formData = new FormData();

            // Ensure we have valid audio data
            if (!audioBuffer || audioBuffer.length === 0) {
                throw new Error('No audio data to send to server');
            }
            
            // Check if audio buffer is empty (VAD filtered out all audio)
            if (audioBuffer.length <= 44) { // WAV header is 44 bytes
                log('[HF-Whisper-ASR] 🔇 Audio buffer is empty after VAD filtering, skipping transcription');
                return null;
            }

            formData.append('audio', audioBuffer, {
                filename: 'audio.wav',
                contentType: 'audio/wav'
            });

            // Add language parameter if specified
            if (huggingFaceWhisperConfig.language) {
                formData.append('language', huggingFaceWhisperConfig.language);
                log(`[HF-Whisper-ASR] Language constraint applied: ${huggingFaceWhisperConfig.language}`);
            } else {
                log('[HF-Whisper-ASR] Using automatic language detection');
            }

            log(`[HF-Whisper-ASR] Sending request to ${huggingFaceWhisperConfig.serverUrl}`);
            log(`[HF-Whisper-ASR] FormData headers: ${JSON.stringify(formData.getHeaders())}`);

            const response = await fetch(huggingFaceWhisperConfig.serverUrl, {
                method: 'POST',
                body: formData,
                headers: formData.getHeaders()
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Hugging Face Whisper server error: ${response.status} ${response.statusText} - ${errorText}`);
            }

            const result = await response.json() as { text?: string };

            // 상세한 API 응답 로깅
            logSuccess(`[HF-Whisper-ASR] 🔍 Raw API response: ${JSON.stringify(result)}`);

            if (result.text && result.text.trim()) {
                const cleanText = result.text.trim();
                logSuccess(`[HF-Whisper-ASR] ✅ Transcription successful: "${cleanText}"`);
                logSuccess(`[HF-Whisper-ASR] 🔍 Text length: ${cleanText.length} characters`);
                return cleanText;
            } else {
                logError(`[HF-Whisper-ASR] ❌ No transcription from Hugging Face Whisper: ${JSON.stringify(result)}`);
                return null;
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logError(`[HF-Whisper-ASR] Transcription error: ${errorMessage}`);
            logError(`[HF-Whisper-ASR] Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
            logError(`[HF-Whisper-ASR] Server URL: ${huggingFaceWhisperConfig.serverUrl}`);
            
            // Test server connectivity
            try {
                const fetch = await import('node-fetch').then(module => module.default);
                const healthResponse = await fetch('http://localhost:5005/health', { 
                    method: 'GET',
                    timeout: 5000 
                });
                logError(`[HF-Whisper-ASR] Server health check: ${healthResponse.status} ${healthResponse.statusText}`);
            } catch (healthError) {
                logError(`[HF-Whisper-ASR] Server health check failed: ${healthError}`);
            }
            
            throw error;
        }
    }

    async forceCleanup(): Promise<void> {
        try {
            log('[HF-Whisper-ASR] Force cleanup initiated');

            // Clear chunk timer
            if (this.chunkTimer) {
                clearInterval(this.chunkTimer);
                this.chunkTimer = null;
            }

            // Stop and destroy microphone
            if (this.microphone) {
                try {
                    if (typeof this.microphone.stopRecording === 'function') {
                        this.microphone.stopRecording();
                    }
                    if (typeof this.microphone.stop === 'function') {
                        this.microphone.stop();
                    }
                    if (typeof this.microphone.destroy === 'function') {
                        this.microphone.destroy();
                    }
                } catch (e) {
                    // Ignore cleanup errors
                }
                this.microphone = null;
            }

            // Stop and destroy audio stream
            if (this.audioStream) {
                try {
                    if (typeof this.audioStream.stop === 'function') {
                        this.audioStream.stop();
                    }
                } catch (e) {
                    // Ignore stop errors
                }
                this.audioStream = null;
            }

            // Clear audio buffer
            this.audioBuffer = [];

            // 녹음 상태 강제 중지
            this.isRecording = false;
            this.isProcessing = false;

            // 중복 방지 상태 완전 초기화
            this.lastTranscriptionText = '';
            this.lastTranscriptionTime = 0;

            log('[HF-Whisper-ASR] Force cleanup completed');
        } catch (error) {
            logError(`[HF-Whisper-ASR] Error during force cleanup: ${error}`);
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }

        log('[HF-Whisper-ASR] Disposing client...');

        try {
            // Clear chunk timer
            if (this.chunkTimer) {
                clearInterval(this.chunkTimer);
                this.chunkTimer = null;
            }

            // Stop microphone
            if (this.microphone) {
                try {
                    if (typeof this.microphone.stopRecording === 'function') {
                        this.microphone.stopRecording();
                    }
                    if (typeof this.microphone.stop === 'function') {
                        this.microphone.stop();
                    }
                    if (typeof this.microphone.destroy === 'function') {
                        this.microphone.destroy();
                    }
                } catch (err) {
                    logError(`[HF-Whisper-ASR] Error disposing microphone: ${err}`);
                }
                this.microphone = null;
            }

            // Stop audio stream
            if (this.audioStream) {
                try {
                    if (typeof this.audioStream.stop === 'function') {
                        this.audioStream.stop();
                    }
                } catch (err) {
                    logError(`[HF-Whisper-ASR] Error disposing audio stream: ${err}`);
                }
                this.audioStream = null;
            }

            // Clear audio buffer
            this.audioBuffer = [];

            // 중복 방지 상태 완전 초기화
            this.lastTranscriptionText = '';
            this.lastTranscriptionTime = 0;
            this.isProcessing = false;

            this.disposed = true;
            log('[HF-Whisper-ASR] Client disposed successfully');
        } catch (error) {
            logError(`[HF-Whisper-ASR] Error during disposal: ${error}`);
        }
    }
}
