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
    // ===== CURRENT WORKING CATEGORIES =====
    // These are the categories the system actually provides:
    
    variable: 'en_3',     // 🔵 Words: function names, variables, classes, etc. (add_talk_simple, PTC, text, font)
    operator: 'en_15',    // 🟠 Math operators: +, -, *, /, = 
    type: 'en_80',        // 🟡 Punctuation & symbols: (), [], {}, quotes, dots, commas
    comment: 'en_41',     // 🟢 Comment text
    
    // ===== FUTURE SEMANTIC TOKEN CATEGORIES =====
    // These will work when semantic token support is added:
    
    // Keywords & Control Flow
    keyword: 'en_35',                // def, if, for, while, class
    'keyword.control': 'en_35',      // if, for, while, def, class  
    'keyword.operator': 'en_15',     // and, or, not, in, is
    'keyword.import': 'en_90',       // import, from, as
    
    // Functions & Methods
    'function.name': 'en_10',        // Function definitions (add_talk_simple)
    'function.call': 'en_12',        // Method calls (.create_clip, .size)
    'function.builtin': 'en_20',     // Built-in functions (int, max, len)
    
    // Strings & Literals
    'string': 'en_25',               // String literals ("black", "center")
    'string.quoted': 'en_25',        // Quoted strings
    literal: 'en_25',                // String literals (fallback)
    
    // Numbers
    'number': 'en_30',               // Numbers (70, 100, 50)
    'number.integer': 'en_30',       // Integer numbers
    'number.float': 'en_32',         // Float numbers
    
    // Classes & Types
    'type.class': 'en_40',           // Class names (PTC, ImageClip)
    'class.name': 'en_40',           // Class names
    'class.builtin': 'en_42',        // Built-in classes
    
    // Parameters & Properties
    'parameter': 'en_50',            // Function parameters (text, font, fontsize)
    'parameter.name': 'en_50',       // Parameter names
    'property': 'en_60',             // Object properties (.h, .w)
    'property.name': 'en_60',        // Property names
    
    // Punctuation (more specific)
    'punctuation': 'en_70',          // General punctuation
    'punctuation.bracket': 'en_70',  // (), [], {}
    'punctuation.delimiter': 'en_72', // , : ;
    
    // Constants
    'constant': 'en_75',             // Constants (True, False, None)
    'constant.builtin': 'en_75',     // Built-in constants
    
    // Modules & Namespaces
    'namespace': 'en_85',            // Module names, imports
    'module': 'en_85',               // Module references
    
    // Special categories
    'special': 'en_5',               // Special characters during typing
    
    // Default fallback
    'text': 'en_5',                  // Plain text
    'default': 'en_5',               // Fallback voice
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
    playSpeed: 2.0,              // playback speed multiplier - now supports pitch preservation!
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
