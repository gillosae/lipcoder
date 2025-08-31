import { log, logError, logWarning, logSuccess } from './utils';
import { handleASRErrorSimple } from './asr_error_handler';
import { gpt4oASRConfig } from './config';
// VAD disabled for Push-to-Talk mode
// import { detectVoiceActivity, createLenientVADConfig } from './utils/vad';
import { filterHallucinations, DEFAULT_HALLUCINATION_CONFIG } from './utils/hallucination_filter';



export interface GPT4oASRChunk {
    text: string;
    confidence?: number;
    timestamp: number;
}

export interface GPT4oASROptions {
    onTranscription?: (chunk: GPT4oASRChunk) => void;
    onError?: (error: Error) => void;
    onRecordingStart?: () => void;
    onRecordingStop?: () => void;
}

export class GPT4oASRClient {
    private isRecording = false;
    private options: GPT4oASROptions;
    private microphone: any = null;
    private audioStream: any = null;
    private audioBuffer: Buffer[] = [];
    private disposed = false;
    private recordingStartTime: number = 0;
    private lastTranscriptionText: string = '';
    private lastTranscriptionTime: number = 0;
    private isProcessing = false; // 처리 중 플래그

    constructor(options: GPT4oASROptions = {}) {
        this.options = options || {};
        log('[Whisper-ASR] WhisperASRClient initialized');
    }

    /**
     * Start recording and transcription
     */
    async startRecording(): Promise<void> {
        logSuccess('🔴 [GPT4o-ASR-DEBUG] startRecording() called!');
        console.log('🔴 [GPT4o-ASR-DEBUG] startRecording() called!');
        
        if (this.isRecording) {
            logWarning('[Whisper-ASR] Already recording - stopping previous session first');
            await this.stopRecording(); // 이전 세션을 완전히 종료
            // 잠시 대기해서 완전히 정리되도록 함
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        logSuccess(`🔴 [GPT4o-ASR-DEBUG] API key exists: ${!!gpt4oASRConfig.apiKey}`);
        if (!gpt4oASRConfig.apiKey) {
            const error = new Error('OpenAI API key is required for Whisper transcription. Please set it in VS Code settings.');
            logError(`[Whisper-ASR] ${error.message}`);
            logError('🔴 [GPT4o-ASR-DEBUG] No API key - returning early');
            if (this.options && this.options.onError) {
                this.options.onError(error);
            }
            return;
        }

        try {
            logSuccess('🔴 [GPT4o-ASR-DEBUG] About to initialize microphone...');
            log('[Whisper-ASR] Starting Whisper ASR recording...');
            
            // 완전히 정리하고 새로 시작
            await this.forceCleanup();
            
            // Clear any existing audio buffers and state to prevent text mixing
            this.audioBuffer = [];
            this.recordingStartTime = Date.now();
            
            // 중복 인식 방지를 위한 상태 초기화
            this.lastTranscriptionText = '';
            this.lastTranscriptionTime = 0;
            this.isProcessing = false;
            
            log('[Whisper-ASR] Cleared audio buffers and reset state to prevent text mixing');
            
            // Initialize microphone with fallback
            let microphoneInitialized = false;
            
            // Try node-microphone first
            try {
                logSuccess('🔴 [GPT4o-ASR-DEBUG] Trying node-microphone...');
                const Microphone = require('node-microphone');
                
                logSuccess('🔴 [GPT4o-ASR-DEBUG] Creating node-microphone instance...');
                this.microphone = new Microphone({
                    rate: gpt4oASRConfig.sampleRate,
                    channels: 1,
                    debug: true, // Enable debug to see more info
                    exitOnSilence: 6
                });

                // Clear audio buffer
                this.audioBuffer = [];
                this.recordingStartTime = Date.now();

                // Start recording
                logSuccess('🔴 [GPT4o-ASR-DEBUG] Starting node-microphone recording...');
                this.audioStream = this.microphone.startRecording();
                
                // Verify stream is valid
                if (!this.audioStream) {
                    throw new Error('node-microphone failed to create audio stream');
                }
                
                this.isRecording = true;
                microphoneInitialized = true;
                logSuccess('🔴 [GPT4o-ASR-DEBUG] node-microphone recording started successfully!');
                logSuccess(`🔴 [GPT4o-ASR-DEBUG] Stream state - readable: ${this.audioStream.readable}, destroyed: ${this.audioStream.destroyed}`);

            } catch (nodeMicError) {
                logError(`🔴 [GPT4o-ASR-DEBUG] node-microphone failed: ${nodeMicError}`);
                
                // Fallback to mic package
                try {
                    logSuccess('🔴 [GPT4o-ASR-DEBUG] Falling back to mic package...');
                    const mic = require('mic');
                    
                    const micInstance = mic({
                        rate: gpt4oASRConfig.sampleRate,
                        channels: '1',
                        debug: true, // Enable debug
                        exitOnSilence: 6
                    });

                    // Clear audio buffer
                    this.audioBuffer = [];
                    this.recordingStartTime = Date.now();

                    // Start recording
                    logSuccess('🔴 [GPT4o-ASR-DEBUG] Getting mic package audio stream...');
                    this.audioStream = micInstance.getAudioStream();
                    
                    // Verify stream is valid
                    if (!this.audioStream) {
                        throw new Error('mic package failed to create audio stream');
                    }
                    
                    logSuccess('🔴 [GPT4o-ASR-DEBUG] Starting mic package...');
                    micInstance.start();
                    
                    this.isRecording = true;
                    this.microphone = micInstance; // Store for cleanup
                    microphoneInitialized = true;
                    logSuccess('🔴 [GPT4o-ASR-DEBUG] mic package recording started successfully!');
                    logSuccess(`🔴 [GPT4o-ASR-DEBUG] Stream state - readable: ${this.audioStream.readable}, destroyed: ${this.audioStream.destroyed}`);

                } catch (micError) {
                    logError(`🔴 [GPT4o-ASR-DEBUG] mic package also failed: ${micError}`);
                    throw new Error(`Both microphone packages failed. node-microphone: ${nodeMicError}, mic: ${micError}`);
                }
            }

            if (!microphoneInitialized) {
                throw new Error('Failed to initialize any microphone package');
            }

            // Handle audio data - Push-to-Talk 방식으로 수정
            this.audioStream.removeAllListeners('data'); // 기존 리스너 제거
            this.audioStream.on('data', (chunk: Buffer) => {
                if (this.isRecording && !this.disposed) {
                    // Push-to-Talk: 단순히 오디오 버퍼에 저장만 함 (실시간 처리 안함)
                    
                    // 버퍼 크기 제한으로 메모리 누수 방지
                    if (this.audioBuffer.length > 500) { // Push-to-Talk에서는 더 많은 버퍼 허용
                        logWarning('[GPT4o-ASR] Audio buffer too large, clearing oldest chunks');
                        this.audioBuffer = this.audioBuffer.slice(-250); // 최근 250개만 유지
                    }
                    
                    this.audioBuffer.push(chunk);
                    // 실시간 처리 제거 - stopRecording()에서만 처리
                }
            });

            // Add error handling for stream
            this.audioStream.on('error', (error: Error) => {
                logError(`🔴 [GPT4o-ASR-DEBUG] Stream error: ${error}`);
                if (this.options && this.options.onError) {
                    this.options.onError(error);
                }
            });

            this.audioStream.on('close', () => {
                logWarning('🔴 [GPT4o-ASR-DEBUG] Stream closed unexpectedly');
            });

            this.audioStream.on('end', () => {
                logWarning('🔴 [GPT4o-ASR-DEBUG] Stream ended unexpectedly');
            });

            // Force stream to start reading
            if (this.audioStream.readable) {
                logSuccess('🔴 [GPT4o-ASR-DEBUG] Stream is readable, forcing read...');
                this.audioStream.resume(); // Force stream to start emitting data events
            }

            // Add timeout to check if we're receiving data
            setTimeout(() => {
                if (this.isRecording && this.audioBuffer.length === 0) {
                    logError('🔴 [GPT4o-ASR-DEBUG] ❌ NO AUDIO DATA received after 3 seconds!');
                    logError('🔴 [GPT4o-ASR-DEBUG] ❌ This indicates a stream flow issue, not microphone permissions');
                    logError(`🔴 [GPT4o-ASR-DEBUG] ❌ Stream readable state: ${this.audioStream?.readable}`);
                    logError(`🔴 [GPT4o-ASR-DEBUG] ❌ Stream paused state: ${this.audioStream?.isPaused?.()}`);
                    
                    // Try to force the stream to start
                    if (this.audioStream) {
                        logError('🔴 [GPT4o-ASR-DEBUG] ❌ Attempting to resume stream...');
                        this.audioStream.resume();
                    }
                } else if (this.isRecording) {
                    logSuccess(`🔴 [GPT4o-ASR-DEBUG] ✅ Audio data is flowing! Received ${this.audioBuffer.length} chunks`);
                }
            }, 3000);

            // Add comprehensive stream event listeners for debugging
            this.audioStream.on('readable', () => {
                logSuccess('🔴 [GPT4o-ASR-DEBUG] Stream readable event fired');
                // Try to manually read data when readable event fires
                let chunk;
                while (null !== (chunk = this.audioStream.read())) {
                    if (this.isRecording) {
                        logSuccess(`🔴 [GPT4o-ASR-DEBUG] Manually read chunk: ${chunk.length} bytes`);
                        this.audioBuffer.push(chunk);
                    }
                }
            });

            this.audioStream.on('end', () => {
                logWarning('🔴 [GPT4o-ASR-DEBUG] Stream ended');
            });

            this.audioStream.on('close', () => {
                logWarning('🔴 [GPT4o-ASR-DEBUG] Stream closed');
            });

            this.audioStream.on('pause', () => {
                logWarning('🔴 [GPT4o-ASR-DEBUG] Stream paused');
            });

            this.audioStream.on('resume', () => {
                logSuccess('🔴 [GPT4o-ASR-DEBUG] Stream resumed');
            });

            // Handle errors
            this.audioStream.on('error', (error: Error) => {
                logError(`[Whisper-ASR] Microphone error: ${error}`);
                logError(`🔴 [GPT4o-ASR-DEBUG] Microphone error: ${error}`);
                if (this.options && this.options.onError) {
                    this.options.onError(error);
                }
                this.stopRecording();
            });

            logSuccess('🔴 [GPT4o-ASR-DEBUG] Calling onRecordingStart callback...');
            if (this.options && this.options.onRecordingStart) {
                this.options.onRecordingStart();
            }

            logSuccess('[Whisper-ASR] Recording started successfully');

        } catch (error) {
            logError(`[Whisper-ASR] Failed to start recording: ${error}`);
            logError(`🔴 [GPT4o-ASR-DEBUG] Error in startRecording(): ${error}`);
            console.error('🔴 [GPT4o-ASR-DEBUG] Error in startRecording():', error);
            if (this.options && this.options.onError) {
                this.options.onError(error as Error);
            } else {
                // Fallback to simple error handler if no callback provided
                await handleASRErrorSimple(error as Error, 'GPT4o ASR Start');
            }
        }
    }

    /**
     * Stop recording and process the audio
     */
    async stopRecording(): Promise<void> {
        if (!this.isRecording) {
            logWarning('[Whisper-ASR] Not currently recording');
            return;
        }

        try {
            log('[Whisper-ASR] Stopping recording and processing audio...');
            this.isRecording = false;

            // Stop microphone
            if (this.microphone) {
                this.microphone.stopRecording();
            }

            // Stop audio stream
            if (this.audioStream) {
                this.audioStream.removeAllListeners();
                this.audioStream = null;
            }

            if (this.options && this.options.onRecordingStop) {
                this.options.onRecordingStop();
            }

            // Process the accumulated audio
            if (this.audioBuffer.length > 0) {
                await this.processAudioBuffer();
            } else {
                logWarning('[Whisper-ASR] No audio data to process');
            }
            
            // Clear audio buffer after processing to prevent text mixing in next session
            this.audioBuffer = [];
            log('[Whisper-ASR] Cleared audio buffer after processing to prevent text mixing');

        } catch (error) {
            logError(`[Whisper-ASR] Error stopping recording: ${error}`);
            if (this.options && this.options.onError) {
                this.options.onError(error as Error);
            } else {
                // Fallback to simple error handler if no callback provided
                await handleASRErrorSimple(error as Error, 'GPT4o ASR Stop');
            }
        } finally {
            // 처리 완료 후 상태 정리
            log('[Whisper-ASR] Stop recording completed');
        }
    }

    /**
     * Process the audio buffer and send to GPT-4o
     */
    private async processAudioBuffer(): Promise<void> {
        // 이미 처리 중이면 잠시 대기 후 재시도
        if (this.isProcessing) {
            log('[Whisper-ASR] Processing in progress, waiting...');
            await new Promise(resolve => setTimeout(resolve, 100));
            if (this.isProcessing) {
                logWarning('[Whisper-ASR] Still processing after wait, skipping duplicate request');
                return;
            }
        }
        
        this.isProcessing = true;
        
        try {
            log(`[Whisper-ASR] Processing audio buffer with ${this.audioBuffer.length} chunks`);

            // Combine all audio chunks
            const combinedAudio = Buffer.concat(this.audioBuffer);
            log(`[Whisper-ASR] Combined audio size: ${combinedAudio.length} bytes`);

            // Convert raw PCM to WAV format
            const wavBuffer = this.createWavFile(combinedAudio);
            log(`[Whisper-ASR] Created WAV buffer: ${wavBuffer.length} bytes`);

            // Check if audio buffer is empty (VAD filtered out all audio)
            if (wavBuffer.length <= 44) { // WAV header is 44 bytes
                log('[GPT4o-ASR] 🔇 Audio buffer is empty after VAD filtering, skipping transcription');
                return;
            }

            // Send to OpenAI
            const rawTranscription = await this.transcribeWithGPT4o(wavBuffer);
            
            if (rawTranscription && rawTranscription.trim()) {
                log(`[GPT4o-ASR] 🔍 Raw transcription: "${rawTranscription}"`);
                
                // Apply hallucination filtering
                const filteredTranscription = filterHallucinations(rawTranscription, DEFAULT_HALLUCINATION_CONFIG, '[GPT4o-ASR]');
                
                if (filteredTranscription && filteredTranscription.trim()) {
                    logSuccess(`[GPT4o-ASR] ✅ Filtered transcription: "${filteredTranscription}"`);
                    
                    const chunk: GPT4oASRChunk = {
                        text: filteredTranscription,
                        timestamp: this.recordingStartTime
                    };

                    log(`[GPT4o-ASR] Final transcription result: "${filteredTranscription}"`);
                    
                    if (this.options && this.options.onTranscription) {
                        this.options.onTranscription(chunk);
                    }
                } else {
                    log('[GPT4o-ASR] 🚫 Transcription filtered out as hallucination');
                }
            } else {
                log('[GPT4o-ASR] No transcription received from OpenAI');
            }

        } catch (error) {
            logError(`[Whisper-ASR] Error processing audio buffer: ${error}`);
            if (this.options && this.options.onError) {
                this.options.onError(error as Error);
            } else {
                // Fallback to simple error handler if no callback provided
                await handleASRErrorSimple(error as Error, 'GPT4o ASR Processing');
            }
        } finally {
            // 처리 완료 플래그 해제
            this.isProcessing = false;
        }
    }

    /**
     * Create WAV file from raw PCM data with audio quality improvements
     */
    private createWavFile(pcmData: Buffer): Buffer {
        // 오디오 품질 향상을 위한 전처리 (다시 활성화)
        const processedData = this.preprocessAudio(pcmData);
        
        const sampleRate = gpt4oASRConfig.sampleRate;
        const numChannels = 1;
        const bitsPerSample = 16;
        const byteRate = sampleRate * numChannels * bitsPerSample / 8;
        const blockAlign = numChannels * bitsPerSample / 8;
        const dataSize = processedData.length;
        const fileSize = 36 + dataSize;

        const header = Buffer.alloc(44);
        let offset = 0;

        // RIFF chunk descriptor
        header.write('RIFF', offset); offset += 4;
        header.writeUInt32LE(fileSize, offset); offset += 4;
        header.write('WAVE', offset); offset += 4;

        // fmt sub-chunk
        header.write('fmt ', offset); offset += 4;
        header.writeUInt32LE(16, offset); offset += 4; // Subchunk1Size for PCM
        header.writeUInt16LE(1, offset); offset += 2; // AudioFormat (1 = PCM)
        header.writeUInt16LE(numChannels, offset); offset += 2;
        header.writeUInt32LE(sampleRate, offset); offset += 4;
        header.writeUInt32LE(byteRate, offset); offset += 4;
        header.writeUInt16LE(blockAlign, offset); offset += 2;
        header.writeUInt16LE(bitsPerSample, offset); offset += 2;

        // data sub-chunk
        header.write('data', offset); offset += 4;
        header.writeUInt32LE(dataSize, offset);

        return Buffer.concat([header, processedData]);
    }



    /**
     * 오디오 전처리로 품질 향상 (노이즈 제거, 볼륨 정규화)
     * Push-to-Talk 모드에서는 VAD 비활성화 (사용자가 의도적으로 녹음 시작)
     */
    private preprocessAudio(audioData: Buffer): Buffer {
        try {
            // 16비트 PCM 데이터로 변환
            const samples = new Int16Array(audioData.buffer, audioData.byteOffset, audioData.length / 2);
            
            // Push-to-Talk 모드에서는 VAD 건너뛰기 (사용자가 의도적으로 녹음)
            log(`[GPT4o-ASR] 🎤 Push-to-Talk mode: Processing all audio without VAD filtering`);
            
            // VAD 없이 전체 샘플 사용
            const processedSamples = new Int16Array(samples.length);
            
            // 1. DC 오프셋 제거 (평균값을 빼서 중앙값 조정)
            let sum = 0;
            for (let i = 0; i < samples.length; i++) {
                sum += samples[i];
            }
            const dcOffset = sum / samples.length;
            
            // 2. 볼륨 정규화 및 노이즈 게이트
            let maxAmplitude = 0;
            for (let i = 0; i < samples.length; i++) {
                const sample = samples[i] - dcOffset;
                maxAmplitude = Math.max(maxAmplitude, Math.abs(sample));
            }
            
            const noiseThreshold = maxAmplitude * 0.02; // 2% 이하는 노이즈로 간주
            const normalizationFactor = maxAmplitude > 0 ? 16000 / maxAmplitude : 1; // 적절한 볼륨으로 정규화
            
            for (let i = 0; i < samples.length; i++) {
                let sample = samples[i] - dcOffset;
                
                // 노이즈 게이트 적용
                if (Math.abs(sample) < noiseThreshold) {
                    sample = 0;
                }
                
                // 볼륨 정규화
                sample *= normalizationFactor;
                
                // 클리핑 방지
                processedSamples[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
            }
            
            logSuccess(`[GPT4o-ASR] Audio preprocessing completed: DC offset=${dcOffset.toFixed(2)}, max amplitude=${maxAmplitude}, normalization factor=${normalizationFactor.toFixed(2)}`);
            
            return Buffer.from(processedSamples.buffer);
            
        } catch (error) {
            logError(`[GPT4o-ASR] Audio preprocessing failed: ${error}`);
            return audioData; // 실패시 원본 데이터 반환
        }
    }

    /**
     * Send audio to Whisper API for transcription
     */
    private async transcribeWithGPT4o(audioBuffer: Buffer): Promise<string> {
        return await this.transcribeWithWhisper(audioBuffer);
    }



    /**
     * Use Whisper API for transcription
     */
    private async transcribeWithWhisper(audioBuffer: Buffer): Promise<string> {
        log('[Whisper-ASR] Using Whisper API for transcription...');

        // Use dynamic imports to handle ES modules
        const FormData = require('form-data');
        const fetch = await import('node-fetch').then(module => module.default);

        const formData = new FormData();
        formData.append('file', audioBuffer, {
            filename: 'audio.wav',
            contentType: 'audio/wav'
        });
        formData.append('model', 'whisper-1');
        
        // Add temperature for anti-hallucination (0.0 = most conservative)
        const temperature = gpt4oASRConfig.temperature || 0.0;
        formData.append('temperature', temperature.toString());
        log(`[GPT4o-ASR] 🎯 Temperature set to ${temperature} (anti-hallucination mode)`);
        
        // Add language parameter for constraint (null enables auto-detection)
        if (gpt4oASRConfig.language) {
            formData.append('language', gpt4oASRConfig.language);
            log(`[Whisper-ASR] Language constraint applied: ${gpt4oASRConfig.language === 'en' ? 'English only' : gpt4oASRConfig.language === 'ko' ? 'Korean only' : gpt4oASRConfig.language}`);
        } else {
            log('[Whisper-ASR] Using automatic language detection (all languages supported)');
        }

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${gpt4oASRConfig.apiKey}`,
                ...formData.getHeaders()
            },
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Whisper API error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const result = await response.json() as { text?: string };
        
        // 상세한 API 응답 로깅
        logSuccess(`[Whisper-ASR] 🔍 Raw API response: ${JSON.stringify(result)}`);
        
        if (result.text && result.text.trim()) {
            const cleanText = result.text.trim();
            logSuccess(`[Whisper-ASR] ✅ Transcription successful: "${cleanText}"`);
            logSuccess(`[Whisper-ASR] 🔍 Text length: ${cleanText.length} characters`);
            return cleanText;
        } else {
            logError(`[Whisper-ASR] ❌ No valid transcription in response: ${JSON.stringify(result)}`);
            throw new Error('No transcription from Whisper');
        }
    }

    /**
     * Check if currently recording
     */
    isCurrentlyRecording(): boolean {
        return this.isRecording;
    }

    /**
     * 유사한 텍스트인지 확인 (중복 인식 방지)
     */
    private isSimilarTranscription(newText: string, lastText: string): boolean {
        if (!lastText || !newText) return false;
        
        // 1. 완전 일치 체크 (공백만 정리)
        const trimmedNew = newText.trim();
        const trimmedLast = lastText.trim();
        if (trimmedNew === trimmedLast) return true;
        
        // 2. 정규화: 소문자, 공백 정리, 특수문자 제거
        const normalize = (text: string) => text.toLowerCase().replace(/[^\w\s가-힣]/g, '').replace(/\s+/g, ' ').trim();
        
        const normalizedNew = normalize(newText);
        const normalizedLast = normalize(lastText);
        
        // 3. 정규화 후 완전 일치
        if (normalizedNew === normalizedLast) return true;
        
        // 4. 한쪽이 다른 쪽을 포함하는 경우 (부분 중복)
        if (normalizedNew.length > 0 && normalizedLast.length > 0) {
            if (normalizedNew.includes(normalizedLast) || normalizedLast.includes(normalizedNew)) {
                return true;
            }
        }
        
        // 5. 레벤슈타인 거리로 유사도 계산 (더 엄격하게)
        const similarity = this.calculateSimilarity(normalizedNew, normalizedLast);
        return similarity > 0.9; // 90% 이상 유사하면 중복으로 간주 (더 엄격)
    }
    
    /**
     * 두 문자열의 유사도 계산 (0~1)
     */
    private calculateSimilarity(str1: string, str2: string): number {
        const len1 = str1.length;
        const len2 = str2.length;
        
        if (len1 === 0) return len2 === 0 ? 1 : 0;
        if (len2 === 0) return 0;
        
        const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(null));
        
        for (let i = 0; i <= len1; i++) matrix[0][i] = i;
        for (let j = 0; j <= len2; j++) matrix[j][0] = j;
        
        for (let j = 1; j <= len2; j++) {
            for (let i = 1; i <= len1; i++) {
                const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[j][i] = Math.min(
                    matrix[j - 1][i] + 1,     // deletion
                    matrix[j][i - 1] + 1,     // insertion
                    matrix[j - 1][i - 1] + cost // substitution
                );
            }
        }
        
        const maxLen = Math.max(len1, len2);
        return (maxLen - matrix[len2][len1]) / maxLen;
    }

    /**
     * Force cleanup of all resources (더 강력한 정리)
     */
    private async forceCleanup(): Promise<void> {
        logWarning('[Whisper-ASR] Force cleanup started...');
        
        try {
            // 녹음 상태 강제 중지
            this.isRecording = false;
            this.isProcessing = false;
            
            // 중복 방지 상태 완전 초기화
            this.lastTranscriptionText = '';
            this.lastTranscriptionTime = 0;
            
            // 오디오 스트림 완전 정리
            if (this.audioStream) {
                try {
                    this.audioStream.removeAllListeners();
                    this.audioStream.pause();
                    if (typeof this.audioStream.destroy === 'function') {
                        this.audioStream.destroy();
                    }
                    if (typeof this.audioStream.end === 'function') {
                        this.audioStream.end();
                    }
                } catch (err) {
                    logError(`[Whisper-ASR] Error cleaning audio stream: ${err}`);
                }
                this.audioStream = null;
            }
            
            // 마이크 완전 정리
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
                    if (typeof this.microphone.kill === 'function') {
                        this.microphone.kill();
                    }
                } catch (err) {
                    logError(`[Whisper-ASR] Error cleaning microphone: ${err}`);
                }
                this.microphone = null;
            }
            
            // 버퍼 완전 정리 및 메모리 해제
            if (this.audioBuffer.length > 0) {
                logWarning(`[Whisper-ASR] Clearing ${this.audioBuffer.length} audio buffer chunks`);
                this.audioBuffer.length = 0; // 더 효율적인 배열 클리어
                this.audioBuffer = [];
            }
            
            // 중복 인식 방지 상태도 초기화
            this.lastTranscriptionText = '';
            this.lastTranscriptionTime = 0;
            
            // 강제 가비지 컬렉션 (가능한 경우)
            if (global.gc) {
                try {
                    global.gc();
                } catch (e) {
                    // 무시
                }
            }
            
            logSuccess('[Whisper-ASR] Force cleanup completed');
            
        } catch (error) {
            logError(`[Whisper-ASR] Error during force cleanup: ${error}`);
        }
    }

    /**
     * Dispose of all resources and clean up
     */
    dispose(): void {
        if (this.disposed) return;

        logWarning('[Whisper-ASR] Disposing WhisperASRClient resources...');

        try {
            // Stop recording first
            if (this.isRecording) {
                this.stopRecording();
            }

            // Cleanup microphone
            if (this.microphone) {
                try {
                    if (typeof this.microphone.stopRecording === 'function') {
                        this.microphone.stopRecording();
                    }
                    if (typeof this.microphone.destroy === 'function') {
                        this.microphone.destroy();
                    }
                } catch (err) {
                    logError(`[Whisper-ASR] Error stopping microphone: ${err}`);
                } finally {
                    this.microphone = null;
                }
            }

            // Cleanup audio stream
            if (this.audioStream) {
                try {
                    this.audioStream.removeAllListeners();
                    this.audioStream.destroy();
                } catch (err) {
                    logError(`[Whisper-ASR] Error cleaning up audio stream: ${err}`);
                } finally {
                    this.audioStream = null;
                }
            }

            // Clear audio buffer
            this.audioBuffer = [];
            
            // 중복 방지 상태 완전 초기화
            this.lastTranscriptionText = '';
            this.lastTranscriptionTime = 0;
            this.isProcessing = false;

            this.disposed = true;
            logSuccess('[Whisper-ASR] WhisperASRClient disposed successfully');

        } catch (error) {
            logError(`[Whisper-ASR] Error during disposal: ${error}`);
        }
    }
} 