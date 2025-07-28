import * as path from 'path';
import type { ExtensionContext } from 'vscode';

let extRoot: string;

// Initialize config with the extension's root path.
export function initConfig(context: ExtensionContext) {
    extRoot = context.extensionPath;
}

// TTS Backends & Config ─────────────────────────────────────────────────────
export enum TTSBackend {
    Silero = 'silero',
    Espeak = 'espeak',
}

export interface SileroConfig {
    pythonPath: string;
    scriptPath: string;
    language: string;
    modelId: string;
    defaultSpeaker?: string;
    sampleRate: number;
}

export let currentBackend = TTSBackend.Silero;
export let sileroConfig: SileroConfig = {
    pythonPath: '',
    scriptPath: '',
    language: 'en',
    modelId: 'v3_en',
    defaultSpeaker: 'en_3',
    sampleRate: 24000,
};

export const categoryVoiceMap: Record<string, string> = {
    variable: 'en_3',
    operator: 'en_15',
    keyword: 'en_35',
    literal: 'en_5',
    comment: 'en_41',
    type: 'en_80',
};

// Allow runtime switching of TTS backend & config
export function setBackend(backend: TTSBackend, partial?: Partial<SileroConfig>) {
    currentBackend = backend;
    if (backend === TTSBackend.Silero && partial) {
        sileroConfig = { ...sileroConfig, ...(partial as SileroConfig) };
    }
}

// Path and Etc Config ─────────────────────────────────────────────────────
export const config = {
    typingSpeechEnabled: true,  // global flag for typing speech
    playSpeed: 1.4,              // playback speed multiplier - now supports pitch preservation!
    preservePitch: true,         // use pitch-preserving time stretching (requires FFmpeg)
    panningEnabled: true,        // enable positional panning for tokens (legacy)
    globalPanningEnabled: true,  // enable global panning system for ALL audio
    gentleAudioStopping: true,   // reduce aggressive audio stopping to minimize crackling

    // Audio Minimap Configuration
    audioMinimapEnabled: true,   // enable audio minimap when cursor moves quickly
    audioMinimapSpeedThreshold: 3.5, // lines per second threshold to trigger minimap (increased to reduce false triggers)
    audioMinimapTimeout: 150,    // minimum milliseconds between line changes to calculate speed (reduced for more responsive detection)

    audioPath: () => path.join(extRoot, 'client', 'audio'),
    alphabetPath: () => path.join(extRoot, 'client', 'audio', 'alphabet'),
    earconPath: () => path.join(extRoot, 'client', 'audio', 'earcon'),
    numberPath: () => path.join(extRoot, 'client', 'audio', 'number'),
    pythonPath: () => path.join(extRoot, 'client', 'src', 'python', 'bin', 'python'),
    scriptPath: () => path.join(extRoot, 'client', 'src', 'python', 'silero_tts_infer.py'),
    specialPath: () => path.join(config.audioPath(), 'special'),
    musicalPath: () => path.join(config.audioPath(), 'musical'),

} as {
    typingSpeechEnabled: boolean;
    playSpeed: number;
    preservePitch: boolean;
    panningEnabled: boolean;
    globalPanningEnabled: boolean;
    gentleAudioStopping: boolean;
    audioMinimapEnabled: boolean;
    audioMinimapSpeedThreshold: number;
    audioMinimapTimeout: number;

    audioPath: () => string;
    alphabetPath: () => string;
    earconPath: () => string;
    numberPath: () => string;
    pythonPath: () => string;
    scriptPath: () => string;
    specialPath: () => string;
    musicalPath: () => string;
};

const specialMap: Record<string, string> =  {
    '!': 'excitation.pcm', '@': 'at.pcm', '#': 'sharp.pcm', '$': 'dollar.pcm',
    '%': 'percent.pcm', '^': 'caret.pcm', '&': 'ampersand.pcm', '*': 'asterisk.pcm',
    '+': 'plus.pcm', '~': 'tilde.pcm', '|': 'bar.pcm', '?': 'question.pcm',
    '₩': 'won.pcm', '=': 'equals.pcm', '`': 'backtick.pcm', '\\': 'backslash.pcm',
};
