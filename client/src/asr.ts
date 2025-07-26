import { log } from './utils';
import { config } from './config';

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
    private mediaStream: MediaStream | null = null;
    private audioContext: AudioContext | null = null;
    private processor: ScriptProcessorNode | null = null;
    private isRecording = false;
    private options: ASROptions;
    private chunkBuffer: Float32Array[] = [];
    private lastChunkTime = 0;

    constructor(options: ASROptions = {}) {
        this.options = {
            chunkDuration: 2000, // 2 seconds per chunk
            sampleRate: 16000, // 16kHz for Silero
            serverUrl: 'http://localhost:5005/asr',
            ...options
        };
    }

    /**
     * Start streaming audio from microphone
     */
    async startStreaming(): Promise<void> {
        try {
            log('[ASR] Starting microphone stream...');
            
            // Get microphone access
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: this.options.sampleRate,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            // Create audio context
            this.audioContext = new AudioContext({
                sampleRate: this.options.sampleRate
            });

            // Create audio source from microphone
            const source = this.audioContext.createMediaStreamSource(this.mediaStream);
            
            // Create script processor for audio processing
            this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
            
            // Handle audio data
            this.processor.onaudioprocess = (event) => {
                if (!this.isRecording) return;
                
                const inputBuffer = event.inputBuffer;
                const inputData = inputBuffer.getChannelData(0);
                
                // Add to chunk buffer
                this.chunkBuffer.push(new Float32Array(inputData));
                
                // Check if we have enough data for a chunk
                const totalSamples = this.chunkBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
                const chunkSamples = (this.options.chunkDuration! * this.options.sampleRate!) / 1000;
                
                if (totalSamples >= chunkSamples) {
                    this.processAudioChunk();
                }
            };

            // Connect the audio nodes
            source.connect(this.processor);
            this.processor.connect(this.audioContext.destination);
            
            this.isRecording = true;
            log('[ASR] Microphone stream started successfully');
            
        } catch (error) {
            log(`[ASR] Error starting microphone stream: ${error}`);
            throw error;
        }
    }

    /**
     * Stop streaming audio
     */
    stopStreaming(): void {
        log('[ASR] Stopping microphone stream...');
        
        this.isRecording = false;
        
        if (this.processor) {
            this.processor.disconnect();
            this.processor = null;
        }
        
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }
        
        this.chunkBuffer = [];
        log('[ASR] Microphone stream stopped');
    }

    /**
     * Process accumulated audio chunk and send to ASR server
     */
    private async processAudioChunk(): Promise<void> {
        if (this.chunkBuffer.length === 0) return;

        try {
            // Concatenate all audio chunks
            const totalSamples = this.chunkBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
            const audioData = new Float32Array(totalSamples);
            
            let offset = 0;
            for (const chunk of this.chunkBuffer) {
                audioData.set(chunk, offset);
                offset += chunk.length;
            }

            // Convert to WAV format
            const wavBlob = this.convertToWAV(audioData);
            
            // Send to ASR server
            const transcription = await this.sendToASRServer(wavBlob);
            
            if (transcription && this.options.onTranscription) {
                const asrChunk: ASRChunk = {
                    text: transcription,
                    timestamp: Date.now()
                };
                this.options.onTranscription(asrChunk);
            }

            // Clear the buffer
            this.chunkBuffer = [];
            
        } catch (error) {
            log(`[ASR] Error processing audio chunk: ${error}`);
            if (this.options.onError) {
                this.options.onError(error as Error);
            }
        }
    }

    /**
     * Convert Float32Array audio data to WAV format
     */
    private convertToWAV(audioData: Float32Array): Blob {
        const sampleRate = this.options.sampleRate!;
        const numChannels = 1;
        const bitsPerSample = 16;
        
        // Convert float32 to int16
        const int16Data = new Int16Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
            const sample = Math.max(-1, Math.min(1, audioData[i]));
            int16Data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }

        // Create WAV header
        const buffer = new ArrayBuffer(44 + int16Data.length * 2);
        const view = new DataView(buffer);
        
        // WAV header
        const writeString = (offset: number, string: string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + int16Data.length * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * bitsPerSample / 8, true);
        view.setUint16(32, numChannels * bitsPerSample / 8, true);
        view.setUint16(34, bitsPerSample, true);
        writeString(36, 'data');
        view.setUint32(40, int16Data.length * 2, true);

        // Copy audio data
        const audioView = new Int16Array(buffer, 44);
        audioView.set(int16Data);

        return new Blob([buffer], { type: 'audio/wav' });
    }

    /**
     * Send audio chunk to ASR server
     */
    private async sendToASRServer(audioBlob: Blob): Promise<string | null> {
        try {
            const formData = new FormData();
            formData.append('audio', audioBlob, 'chunk.wav');

            const response = await fetch(this.options.serverUrl!, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`ASR server error: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();
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
        return this.isRecording;
    }

    /**
     * Update options
     */
    updateOptions(newOptions: Partial<ASROptions>): void {
        this.options = { ...this.options, ...newOptions };
    }
}

// Convenience function for quick ASR usage
export async function startASRStreaming(
    onTranscription: (chunk: ASRChunk) => void,
    options?: Partial<ASROptions>
): Promise<ASRClient> {
    const client = new ASRClient({
        onTranscription,
        ...options
    });
    
    await client.startStreaming();
    return client;
}
