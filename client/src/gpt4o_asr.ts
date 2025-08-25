import { log, logError, logWarning, logSuccess } from './utils';
import { handleASRErrorSimple } from './asr_error_handler';
import { gpt4oASRConfig } from './config';

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

    constructor(options: GPT4oASROptions = {}) {
        this.options = options || {};
        log('[Whisper-ASR] WhisperASRClient initialized');
    }

    /**
     * Start recording and transcription
     */
    async startRecording(): Promise<void> {
        if (this.isRecording) {
            logWarning('[Whisper-ASR] Already recording');
            return;
        }

        if (!gpt4oASRConfig.apiKey) {
            const error = new Error('OpenAI API key is required for Whisper transcription. Please set it in VS Code settings.');
            logError(`[Whisper-ASR] ${error.message}`);
            if (this.options && this.options.onError) {
                this.options.onError(error);
            }
            return;
        }

        try {
            log('[Whisper-ASR] Starting Whisper ASR recording...');
            
            // Initialize microphone
            const Microphone = require('node-microphone');
            this.microphone = new Microphone({
                rate: gpt4oASRConfig.sampleRate,
                channels: 1,
                debug: false,
                exitOnSilence: 6
            });

            // Clear audio buffer
            this.audioBuffer = [];
            this.recordingStartTime = Date.now();

            // Start recording
            this.audioStream = this.microphone.startRecording();
            this.isRecording = true;

            // Handle audio data
            this.audioStream.on('data', (chunk: Buffer) => {
                if (this.isRecording) {
                    this.audioBuffer.push(chunk);
                }
            });

            // Handle errors
            this.audioStream.on('error', (error: Error) => {
                logError(`[Whisper-ASR] Microphone error: ${error}`);
                if (this.options && this.options.onError) {
                    this.options.onError(error);
                }
                this.stopRecording();
            });

            if (this.options && this.options.onRecordingStart) {
                this.options.onRecordingStart();
            }

            logSuccess('[Whisper-ASR] Recording started successfully');

        } catch (error) {
            logError(`[Whisper-ASR] Failed to start recording: ${error}`);
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

        } catch (error) {
            logError(`[Whisper-ASR] Error stopping recording: ${error}`);
            if (this.options && this.options.onError) {
                this.options.onError(error as Error);
            } else {
                // Fallback to simple error handler if no callback provided
                await handleASRErrorSimple(error as Error, 'GPT4o ASR Stop');
            }
        }
    }

    /**
     * Process the audio buffer and send to GPT-4o
     */
    private async processAudioBuffer(): Promise<void> {
        try {
            log(`[Whisper-ASR] Processing audio buffer with ${this.audioBuffer.length} chunks`);

            // Combine all audio chunks
            const combinedAudio = Buffer.concat(this.audioBuffer);
            log(`[Whisper-ASR] Combined audio size: ${combinedAudio.length} bytes`);

            // Convert raw PCM to WAV format
            const wavBuffer = this.createWavFile(combinedAudio);
            log(`[Whisper-ASR] Created WAV buffer: ${wavBuffer.length} bytes`);

            // Send to OpenAI
            const transcription = await this.transcribeWithGPT4o(wavBuffer);
            
            if (transcription && transcription.trim()) {
                const chunk: GPT4oASRChunk = {
                    text: transcription,
                    timestamp: this.recordingStartTime
                };

                log(`[Whisper-ASR] Transcription result: "${transcription}"`);
                
                if (this.options && this.options.onTranscription) {
                    this.options.onTranscription(chunk);
                }
            } else {
                log('[Whisper-ASR] No transcription received');
            }

        } catch (error) {
            logError(`[Whisper-ASR] Error processing audio buffer: ${error}`);
            if (this.options && this.options.onError) {
                this.options.onError(error as Error);
            } else {
                // Fallback to simple error handler if no callback provided
                await handleASRErrorSimple(error as Error, 'GPT4o ASR Processing');
            }
        }
    }

    /**
     * Create WAV file from raw PCM data
     */
    private createWavFile(pcmData: Buffer): Buffer {
        const sampleRate = gpt4oASRConfig.sampleRate;
        const numChannels = 1;
        const bitsPerSample = 16;
        const byteRate = sampleRate * numChannels * bitsPerSample / 8;
        const blockAlign = numChannels * bitsPerSample / 8;
        const dataSize = pcmData.length;
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

        return Buffer.concat([header, pcmData]);
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
        
        // Only add language parameter if specified (null enables auto-detection)
        if (gpt4oASRConfig.language) {
            formData.append('language', gpt4oASRConfig.language);
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
        
        if (result.text && result.text.trim()) {
            logSuccess(`[Whisper-ASR] Transcription successful: "${result.text}"`);
            return result.text.trim();
        } else {
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

            this.disposed = true;
            logSuccess('[Whisper-ASR] WhisperASRClient disposed successfully');

        } catch (error) {
            logError(`[Whisper-ASR] Error during disposal: ${error}`);
        }
    }
} 