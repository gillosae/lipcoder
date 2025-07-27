import { log } from './utils';

export interface ASRChunk {
    text: string;
    confidence?: number;
    timestamp: number;
}

export interface ASROptions {
    chunkDuration?: number; // Duration of each audio chunk in milliseconds
    sampleRate?: number; // Audio sample rate
    serverUrl?: string; // Silero ASR server URL
    onTranscription?: (chunk: ASRChunk) => void; // Callback for each transcription
    onError?: (error: Error) => void; // Error callback
}

export class ASRClient {
    private isRecording = false;
    private options: ASROptions;
    private microphone: any = null;
    private audioStream: any = null;
    private startTime: number = 0;
    private chunkCount: number = 0;
    private totalAudioProcessed: number = 0;
    private audioBuffer: Buffer[] = [];
    private chunkTimer: NodeJS.Timeout | null = null;

    constructor(options: ASROptions = {}) {
        this.options = {
            chunkDuration: 2000, // 2 seconds
            sampleRate: 16000, // 16kHz
            serverUrl: 'http://localhost:5005/asr',
            ...options
        };
        log(`[ASR] ASRClient initialized with options: ${JSON.stringify(this.options)}`);
    }

    /**
     * Start streaming audio from microphone
     */
    async startStreaming(): Promise<void> {
        try {
            log('[ASR] Starting real microphone stream...');
            log(`[ASR] Stream configuration: chunkDuration=${this.options.chunkDuration}, sampleRate=${this.options.sampleRate}, serverUrl=${this.options.serverUrl}`);
            
            // Import microphone module
            const Microphone = require('node-microphone');
            this.microphone = new Microphone({
                rate: this.options.sampleRate,
                channels: 1,
                debug: false,
                exitOnSilence: 6
            });
            
            log('[ASR] Microphone initialized');
            
            // Start recording
            this.audioStream = this.microphone.startRecording();
            this.isRecording = true;
            this.startTime = Date.now();
            this.chunkCount = 0;
            this.totalAudioProcessed = 0;
            this.audioBuffer = [];
            
            log('[ASR] Real microphone stream started successfully');
            log(`[ASR] Recording session started at: ${new Date(this.startTime).toISOString()}`);
            
            // Set up audio chunk processing
            this.setupAudioChunkProcessing();
            
        } catch (error) {
            log(`[ASR] Error starting microphone stream: ${error}`);
            throw error;
        }
    }

    /**
     * Set up audio chunk processing timer
     */
    private setupAudioChunkProcessing(): void {
        if (this.chunkTimer) {
            clearInterval(this.chunkTimer);
        }
        
        // Handle incoming audio data from microphone
        this.audioStream.on('data', (chunk: Buffer) => {
            if (this.isRecording) {
                log(`[ASR] Received real audio chunk: ${chunk.length} bytes`);
                this.audioBuffer.push(chunk);
            }
        });
        
        this.chunkTimer = setInterval(async () => {
            if (this.isRecording && this.audioBuffer.length > 0) {
                // Combine all audio chunks
                const combinedAudio = Buffer.concat(this.audioBuffer);
                this.audioBuffer = []; // Clear buffer
                
                log(`[ASR] Processing real audio chunk: ${combinedAudio.length} bytes`);
                await this.processAudioChunk(combinedAudio);
            }
        }, this.options.chunkDuration);
        
        log(`[ASR] Audio chunk processing timer set up: ${this.options.chunkDuration}ms intervals`);
    }

    /**
     * Stop streaming audio
     */
    stopStreaming(): void {
        log('[ASR] Stopping real microphone stream...');
        
        if (this.chunkTimer) {
            clearInterval(this.chunkTimer);
            this.chunkTimer = null;
        }
        
        if (this.microphone) {
            this.microphone.stopRecording();
            this.microphone = null;
        }
        
        const sessionDuration = Date.now() - this.startTime;
        const averageChunkTime = this.chunkCount > 0 ? sessionDuration / this.chunkCount : 0;
        
        log(`[ASR] Recording session statistics: sessionDuration=${sessionDuration}ms, chunksProcessed=${this.chunkCount}, averageChunkTime=${averageChunkTime.toFixed(2)}ms, totalAudioProcessed=${this.totalAudioProcessed} bytes`);
        
        this.isRecording = false;
        
        log('[ASR] Real microphone stream stopped');
    }

    /**
     * Process accumulated audio chunk and send to ASR server
     */
    private async processAudioChunk(audioData: Buffer): Promise<void> {
        if (!this.isRecording) {
            log('[ASR] Ignoring audio chunk - not currently recording');
            return;
        }

        try {
            log(`[ASR] Processing real audio chunk: ${audioData.length} bytes`);
            this.chunkCount++;
            this.totalAudioProcessed += audioData.length;
            
            const chunkStartTime = Date.now();
            
            // Convert audio data to WAV format
            log('[ASR] Converting real audio to WAV format...');
            const wavBuffer = this.convertToWAV(audioData);
            log(`[ASR] WAV conversion complete: ${wavBuffer.length} bytes output`);
            
            // Send to ASR server
            log('[ASR] Sending real audio chunk to ASR server...');
            const transcription = await this.sendToASRServer(wavBuffer);
            
            const processingTime = Date.now() - chunkStartTime;
            log(`[ASR] Real audio chunk processed in ${processingTime}ms`);
            
            if (transcription) {
                log(`[ASR] Real transcription received: "${transcription}"`);
                if (this.options.onTranscription) {
                    const asrChunk: ASRChunk = {
                        text: transcription,
                        timestamp: Date.now()
                    };
                    log(`[ASR] Calling transcription callback with real text: "${transcription}"`);
                    this.options.onTranscription(asrChunk);
                    log(`[ASR] Real transcription callback completed`);
                } else {
                    log(`[ASR] No transcription callback registered, real transcription: "${transcription}"`);
                }
            } else {
                log('[ASR] No real transcription received from server');
            }
            
        } catch (error) {
            log(`[ASR] Error processing real audio chunk: ${error}`);
            if (this.options.onError) {
                this.options.onError(error as Error);
            }
        }
    }

    /**
     * Convert audio data to WAV format
     */
    private convertToWAV(audioData: Buffer): Buffer {
        log(`[ASR] Converting ${audioData.length} bytes of audio data to WAV`);
        
        const sampleRate = this.options.sampleRate!;
        const numChannels = 1;
        const bitsPerSample = 16;
        
        log(`[ASR] WAV conversion parameters: sampleRate=${sampleRate}, numChannels=${numChannels}, bitsPerSample=${bitsPerSample}, inputSize=${audioData.length}`);
        
        // Handle different input types
        let float32Data: Float32Array;
        if (audioData.length % 4 === 0) {
            // Assume it's a Float32Array buffer
            float32Data = new Float32Array(audioData.buffer, audioData.byteOffset, audioData.length / 4);
        } else {
            // Assume it's raw PCM data, convert to Float32Array
            float32Data = new Float32Array(audioData.length);
            for (let i = 0; i < audioData.length; i++) {
                float32Data[i] = (audioData[i] - 128) / 128; // Convert 8-bit to float
            }
        }
        
        // Convert float32 to int16
        const int16Data = new Int16Array(float32Data.length);
        for (let i = 0; i < float32Data.length; i++) {
            const sample = Math.max(-1, Math.min(1, float32Data[i]));
            int16Data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }

        // Create WAV header
        const buffer = Buffer.alloc(44 + int16Data.length * 2);
        
        // WAV header
        buffer.write('RIFF', 0);
        buffer.writeUInt32LE(36 + int16Data.length * 2, 4);
        buffer.write('WAVE', 8);
        buffer.write('fmt ', 12);
        buffer.writeUInt32LE(16, 16);
        buffer.writeUInt16LE(1, 20);
        buffer.writeUInt16LE(numChannels, 22);
        buffer.writeUInt32LE(sampleRate, 24);
        buffer.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28);
        buffer.writeUInt16LE(numChannels * bitsPerSample / 8, 32);
        buffer.writeUInt16LE(bitsPerSample, 34);
        buffer.write('data', 36);
        buffer.writeUInt32LE(int16Data.length * 2, 40);

        // Copy audio data
        const audioBuffer = Buffer.from(int16Data.buffer);
        audioBuffer.copy(buffer, 44);

        log(`[ASR] WAV conversion complete: ${buffer.length} bytes output`);
        return buffer;
    }

    /**
     * Send audio chunk to ASR server
     */
    private async sendToASRServer(audioBuffer: Buffer): Promise<string | null> {
        try {
            log(`[ASR] Sending ${audioBuffer.length} bytes to ASR server: ${this.options.serverUrl}`);
            
            // Try a different approach - send as raw WAV data
            const response = await fetch(this.options.serverUrl!, {
                method: 'POST',
                headers: {
                    'Content-Type': 'audio/wav',
                    'Content-Length': audioBuffer.length.toString()
                },
                body: audioBuffer
            });

            const requestTime = Date.now() - Date.now();
            log(`[ASR] Server response received in ${requestTime}ms: status=${response.status}, statusText=${response.statusText}`);

            if (!response.ok) {
                const errorText = await response.text();
                log(`[ASR] Server error response: ${errorText}`);
                throw new Error(`ASR server error: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();
            log(`[ASR] Server response parsed: ${JSON.stringify(result)}`);
            return result.text || null;

        } catch (error) {
            log(`[ASR] Error sending to server: ${error}`);
            throw error;
        }
    }

    /**
     * Get current recording status
     */
    getRecordingStatus(): boolean {
        log(`[ASR] Recording status requested: ${this.isRecording}`);
        return this.isRecording;
    }

    /**
     * Update options
     */
    updateOptions(newOptions: Partial<ASROptions>): void {
        log(`[ASR] Updating options: ${JSON.stringify(newOptions)}`);
        this.options = { ...this.options, ...newOptions };
        log(`[ASR] Options updated: ${JSON.stringify(this.options)}`);
    }

    /**
     * Test server connection
     */
    async testServerConnection(): Promise<boolean> {
        try {
            log(`[ASR] Testing server connection: ${this.options.serverUrl}`);
            const response = await fetch(this.options.serverUrl!, {
                method: 'OPTIONS'
            });
            const isConnected = response.ok;
            log(`[ASR] Server connection test result: ${isConnected ? 'SUCCESS' : 'FAILED'}`);
            return isConnected;
        } catch (error) {
            log(`[ASR] Server connection test failed: ${error}`);
            return false;
        }
    }

    /**
     * Get recording statistics
     */
    getRecordingStats() {
        return {
            isRecording: this.isRecording,
            sessionDuration: this.startTime > 0 ? Date.now() - this.startTime : 0,
            chunkCount: this.chunkCount,
            totalAudioProcessed: this.totalAudioProcessed,
            averageChunkSize: this.chunkCount > 0 ? this.totalAudioProcessed / this.chunkCount : 0
        };
    }

    /**
     * Simulate transcription for testing purposes
     * This is useful when testing the VS Code extension without actual audio
     */
    simulateTranscription(text: string): void {
        log(`[ASR] Simulating transcription: "${text}"`);
        if (this.options.onTranscription) {
            const asrChunk: ASRChunk = {
                text: text,
                timestamp: Date.now()
            };
            log(`[ASR] Calling transcription callback with simulated text: "${text}"`);
            this.options.onTranscription(asrChunk);
            log(`[ASR] Simulated transcription callback completed`);
        } else {
            log(`[ASR] No transcription callback registered for simulated text: "${text}"`);
        }
    }

    /**
     * Simulate audio processing for testing purposes
     * This creates a fake audio chunk and processes it through the normal flow
     */
    async simulateAudioProcessing(text: string = "This is a simulated transcription"): Promise<void> {
        log(`[ASR] Simulating audio processing with text: "${text}"`);
        
        if (!this.isRecording) {
            log('[ASR] Cannot simulate audio processing - not currently recording');
            return;
        }

        try {
            // Create a proper WAV file instead of raw buffer
            const sampleRate = this.options.sampleRate!;
            const duration = 2; // 2 seconds
            const numSamples = sampleRate * duration;
            
            // Create a simple sine wave (440 Hz) as test audio
            const audioData = new Float32Array(numSamples);
            for (let i = 0; i < numSamples; i++) {
                audioData[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.1; // Low volume
            }
            
            // Convert to WAV format
            const wavBuffer = this.convertToWAV(Buffer.from(audioData.buffer));
            log(`[ASR] Created proper WAV file: ${wavBuffer.length} bytes`);
            
            // Process the WAV file through normal flow
            await this.processAudioChunk(wavBuffer);
            
            // Override the transcription with our test text
            log(`[ASR] Overriding transcription with test text: "${text}"`);
            this.simulateTranscription(text);
            
        } catch (error) {
            log(`[ASR] Error simulating audio processing: ${error}`);
            if (this.options.onError) {
                this.options.onError(error as Error);
            }
        }
    }
}

// Convenience function for quick ASR usage
export async function startASRStreaming(
    onTranscription: (chunk: ASRChunk) => void,
    options?: Partial<ASROptions>
): Promise<ASRClient> {
    log('[ASR] Starting ASR streaming with convenience function');
    const client = new ASRClient({
        onTranscription,
        ...options
    });
    
    await client.startStreaming();
    return client;
}
