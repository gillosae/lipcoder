/**
 * Voice Activity Detection (VAD) Utilities
 * 
 * Advanced VAD implementation with spectral analysis for detecting voice activity
 * in audio samples. Uses multiple features including energy, zero crossing rate,
 * and spectral centroid for robust voice detection.
 */

import { log } from '../utils';

export interface VADResult {
    hasVoice: boolean;
    confidence: number;
    trimmedSamples: Int16Array;
    voiceRatio: number;
    voiceFrames: number;
    totalFrames: number;
}

export interface VADConfig {
    energyThreshold: number;
    zcrThreshold: number;
    centroidMin: number;
    centroidMax: number;
    voiceRatioThreshold: number;
    frameSize: number;  // in samples
    frameStep: number;  // in samples
}

/**
 * Default VAD configuration optimized for speech detection (very permissive)
 */
export const DEFAULT_VAD_CONFIG: VADConfig = {
    energyThreshold: 25,     // Very low threshold for even whisper-level speech
    zcrThreshold: 0.001,     // Extremely low threshold for voice detection
    centroidMin: 50,         // Very wide frequency range (Hz)
    centroidMax: 8000,       // Very wide frequency range (Hz)
    voiceRatioThreshold: 0.005, // Just 0.5% voice activity needed (extremely lenient)
    frameSize: 400,          // 25ms at 16kHz (will be calculated based on sample rate)
    frameStep: 160           // 10ms at 16kHz (will be calculated based on sample rate)
};

/**
 * Advanced VAD (Voice Activity Detection) with spectral analysis
 * 
 * @param samples - Audio samples as Int16Array
 * @param sampleRate - Sample rate in Hz (default: 16000)
 * @param config - VAD configuration (optional, uses defaults if not provided)
 * @param logPrefix - Prefix for log messages (optional)
 * @returns VADResult with voice detection information
 */
export function detectVoiceActivity(
    samples: Int16Array, 
    sampleRate: number = 16000, 
    config: Partial<VADConfig> = {},
    logPrefix: string = '[VAD]'
): VADResult {
    // Merge with default config
    const vadConfig: VADConfig = { ...DEFAULT_VAD_CONFIG, ...config };
    
    // Calculate frame sizes based on sample rate
    const frameSize = Math.floor(sampleRate * 0.025); // 25ms frames
    const frameStep = Math.floor(sampleRate * 0.010); // 10ms step
    const numFrames = Math.floor((samples.length - frameSize) / frameStep) + 1;
    
    let voiceFrames = 0;
    let totalEnergy = 0;
    let spectralCentroid = 0;
    let zeroCrossingRate = 0;
    
    const voiceFrameIndices: number[] = [];
    
    for (let frame = 0; frame < numFrames; frame++) {
        const start = frame * frameStep;
        const end = Math.min(start + frameSize, samples.length);
        
        // Energy calculation
        let energy = 0;
        let zcr = 0;
        let spectralSum = 0;
        let spectralWeightedSum = 0;
        
        for (let i = start; i < end - 1; i++) {
            const sample = samples[i];
            energy += sample * sample;
            
            // Zero crossing rate
            if ((samples[i] >= 0) !== (samples[i + 1] >= 0)) {
                zcr++;
            }
            
            // Simple spectral analysis (approximation)
            const freq = (i - start) / frameSize * sampleRate / 2;
            const magnitude = Math.abs(sample);
            spectralSum += magnitude;
            spectralWeightedSum += magnitude * freq;
        }
        
        energy = Math.sqrt(energy / (end - start));
        zcr = zcr / (end - start - 1);
        const centroid = spectralSum > 0 ? spectralWeightedSum / spectralSum : 0;
        
        // Voice activity decision based on multiple features
        const isVoice = energy > vadConfig.energyThreshold && 
                       zcr > vadConfig.zcrThreshold && 
                       centroid > vadConfig.centroidMin && 
                       centroid < vadConfig.centroidMax;
        
        if (isVoice) {
            voiceFrames++;
            voiceFrameIndices.push(frame);
        }
        
        totalEnergy += energy;
        spectralCentroid += centroid;
        zeroCrossingRate += zcr;
    }
    
    const voiceRatio = numFrames > 0 ? voiceFrames / numFrames : 0;
    const hasVoice = voiceRatio > vadConfig.voiceRatioThreshold;
    const confidence = Math.min(voiceRatio * 5, 1.0); // Confidence score
    
    // Trim silence from beginning and end
    let trimmedSamples = samples;
    if (hasVoice && voiceFrameIndices.length > 0) {
        const firstVoiceFrame = voiceFrameIndices[0];
        const lastVoiceFrame = voiceFrameIndices[voiceFrameIndices.length - 1];
        
        const trimStart = Math.max(0, firstVoiceFrame * frameStep - frameSize);
        const trimEnd = Math.min(samples.length, (lastVoiceFrame + 1) * frameStep + frameSize);
        
        trimmedSamples = samples.slice(trimStart, trimEnd);
    }
    
    log(`${logPrefix} VAD Analysis: voice=${hasVoice}, confidence=${confidence.toFixed(2)}, frames=${voiceFrames}/${numFrames}, ratio=${voiceRatio.toFixed(2)}`);
    
    return {
        hasVoice,
        confidence,
        trimmedSamples,
        voiceRatio,
        voiceFrames,
        totalFrames: numFrames
    };
}

/**
 * Create a lenient VAD configuration for sensitive voice detection
 */
export function createLenientVADConfig(): VADConfig {
    return {
        ...DEFAULT_VAD_CONFIG,
        energyThreshold: 10,     // Extremely low threshold for any sound
        zcrThreshold: 0.0001,    // Almost no threshold
        voiceRatioThreshold: 0.001 // Just 0.1% voice activity needed
    };
}

/**
 * Create an ultra-permissive VAD configuration that catches almost any audio
 */
export function createUltraPermissiveVADConfig(): VADConfig {
    return {
        ...DEFAULT_VAD_CONFIG,
        energyThreshold: 5,      // Catches even background noise
        zcrThreshold: 0.00001,   // Practically no threshold
        centroidMin: 20,         // Extremely wide range
        centroidMax: 20000,      // Extremely wide range
        voiceRatioThreshold: 0.0001 // 0.01% voice activity needed
    };
}

/**
 * Create a strict VAD configuration for noise rejection
 */
export function createStrictVADConfig(): VADConfig {
    return {
        ...DEFAULT_VAD_CONFIG,
        energyThreshold: 500,    // Higher threshold
        zcrThreshold: 0.05,      // Higher threshold
        voiceRatioThreshold: 0.1 // 10% voice activity needed
    };
}
