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
    OpenAI = 'openai',
}

// ASR Backends & Config ─────────────────────────────────────────────────────
export enum ASRBackend {
    Silero = 'silero',
    GPT4o = 'gpt4o-transcribe',
}

// LLM Backends & Config ─────────────────────────────────────────────────────
export enum LLMBackend {
    ChatGPT = 'chatgpt',
    Claude = 'claude',
}

export interface SileroASRConfig {
    serverUrl: string;
    sampleRate: number;
    chunkDuration: number;
}

export interface GPT4oASRConfig {
    apiKey: string;
    model: string; // Whisper model (whisper-1)
    language?: string | null; // null for auto-detection, string for specific language
    sampleRate: number;
    temperature?: number;
}

export interface SileroConfig {
    pythonPath: string;
    scriptPath: string;
    language: string;
    modelId: string;
    defaultSpeaker?: string;
    sampleRate: number;
}

export interface EspeakConfig {
    language: string;
    defaultVoice: string;
    speed: number;        // words per minute (default: 175)
    pitch: number;        // 0-99 (default: 50)
    amplitude: number;    // 0-200 (default: 100)
    gap: number;          // gap between words in 10ms units
    sampleRate: number;   // output sample rate
}

export interface OpenAITTSConfig {
    apiKey: string;
    model: string;        // tts-1 or tts-1-hd
    voice: string;        // alloy, echo, fable, onyx, nova, shimmer
    language: string;     // ko for Korean, en for English, etc.
    speed: number;        // 0.25 to 4.0 (default: 1.0)
    responseFormat: string; // mp3, opus, aac, flac, wav, pcm
    volumeBoost: number;  // Volume boost multiplier (1.0 = no change, 1.5 = 50% louder)
}

export interface ClaudeConfig {
    apiKey: string;
    model: string;        // claude-3-5-sonnet-20241022, claude-3-haiku-20240307, etc.
    maxTokens: number;    // maximum tokens for response
    temperature: number;  // 0.0 to 1.0 (default: 0.1 for code)
}

export let currentBackend = TTSBackend.Silero;

// ASR Configuration ─────────────────────────────────────────────────────
export let currentASRBackend = ASRBackend.GPT4o; // Default to GPT-4o as requested

// LLM Configuration ─────────────────────────────────────────────────────
export let currentLLMBackend = LLMBackend.Claude; // Default to Claude as requested

export let sileroASRConfig: SileroASRConfig = {
    serverUrl: 'http://localhost:5004/asr',
    sampleRate: 16000,
    chunkDuration: 2000, // 2 seconds
};

export let gpt4oASRConfig: GPT4oASRConfig = {
    apiKey: '', // Will be loaded from VS Code settings
    model: 'whisper-1', // Using Whisper for reliable transcription
    language: null, // null for automatic language detection (supports Korean, English, etc.)
    sampleRate: 16000, // Whisper prefers 16kHz
    temperature: 0.0, // For accurate transcription
};

export let sileroConfig: SileroConfig = {
    pythonPath: '',
    scriptPath: '',
    language: 'en',
    modelId: 'v3_en',
    defaultSpeaker: 'en_3',
    sampleRate: 24000,
};

export let espeakConfig: EspeakConfig = {
    language: 'en',
    defaultVoice: 'en-us',  // Use valid espeak-ng voice name
    speed: 175,
    pitch: 50,
    amplitude: 100,
    gap: 0,
    sampleRate: 24000,
};

export let openaiTTSConfig: OpenAITTSConfig = {
    apiKey: '', // Will be loaded from VS Code settings
    model: 'tts-1', // Use standard model by default
    voice: 'alloy', // Default voice
    language: 'ko', // Korean language
    speed: 1.0, // Normal speed
    responseFormat: 'wav', // WAV format for compatibility
    volumeBoost: 1.3, // 30% volume boost for Korean TTS
};

export let claudeConfig: ClaudeConfig = {
    apiKey: '', // Will be loaded from VS Code settings
    model: 'claude-sonnet-4-20250514', // Latest Sonnet model
    maxTokens: 2000, // Max tokens for code modifications
    temperature: 0.1, // Low temperature for consistent code generation
};

export const categoryVoiceMap: Record<string, string> = {
    // ===== CURRENT WORKING CATEGORIES =====
    variable: 'en_3',
    operator: 'en_15',
    keyword: 'en_35', // def, if, for, etc.
    literal: 'en_5',
    comment: 'en_41',
    type: 'en_80',

    // These are the categories the system actually provides:
    
    // variable: 'en_3',     // 🔵 Words: function names, variables, classes, etc. (add_talk_simple, PTC, text, font)
    // operator: 'en_15',    // 🟠 Math operators: +, -, *, /, = 
    // type: 'en_80',        // 🟡 Punctuation & symbols: (), [], {}, quotes, dots, commas
    // comment: 'en_41',     // 🟢 Comment text
    
    // // ===== FUTURE SEMANTIC TOKEN CATEGORIES =====
    // // These will work when semantic token support is added:
    
    // // Keywords & Control Flow
    // keyword: 'en_35',                // def, if, for, while, class
    // 'keyword.control': 'en_35',      // if, for, while, def, class  
    // 'keyword.operator': 'en_15',     // and, or, not, in, is
    // 'keyword.import': 'en_90',       // import, from, as
    
    // // Functions & Methods
    // 'function.name': 'en_10',        // Function definitions (add_talk_simple)
    // 'function.call': 'en_12',        // Method calls (.create_clip, .size)
    // 'function.builtin': 'en_20',     // Built-in functions (int, max, len)
    
    // // Strings & Literals
    // 'string': 'en_25',               // String literals ("black", "center")
    // 'string.quoted': 'en_25',        // Quoted strings
    // literal: 'en_25',                // String literals (fallback)
    
    // // Numbers
    // 'number': 'en_30',               // Numbers (70, 100, 50)
    // 'number.integer': 'en_30',       // Integer numbers
    // 'number.float': 'en_32',         // Float numbers
    
    // // Classes & Types
    // 'type.class': 'en_40',           // Class names (PTC, ImageClip)
    // 'class.name': 'en_40',           // Class names
    // 'class.builtin': 'en_42',        // Built-in classes
    
    // // Parameters & Properties
    // 'parameter': 'en_50',            // Function parameters (text, font, fontsize)
    // 'parameter.name': 'en_50',       // Parameter names
    // 'property': 'en_60',             // Object properties (.h, .w)
    // 'property.name': 'en_60',        // Property names
    
    // // Punctuation (more specific)
    // 'punctuation': 'en_70',          // General punctuation
    // 'punctuation.bracket': 'en_70',  // (), [], {}
    // 'punctuation.delimiter': 'en_72', // , : ;
    
    // // Constants
    // 'constant': 'en_75',             // Constants (True, False, None)
    // 'constant.builtin': 'en_75',     // Built-in constants
    
    // // Modules & Namespaces
    // 'namespace': 'en_85',            // Module names, imports
    // 'module': 'en_85',               // Module references
    
    // // Special categories
    // 'special': 'en_5',               // Special characters during typing
    
    // // Default fallback
    // 'text': 'en_5',                  // Plain text
    // 'default': 'en_5',               // Fallback voice
};

// Espeak voice mapping for different categories
export const espeakCategoryVoiceMap: Record<string, Partial<EspeakConfig>> = {
    // Different voices and settings for semantic categories
    // Note: espeak-ng doesn't have multiple speakers like Silero, so we use different
    // language variants and parameter changes to create variety
    
    variable: { defaultVoice: 'en-us', pitch: 50, speed: 175, amplitude: 100 },     // Variables, function names - default US voice
    operator: { defaultVoice: 'en-gb', pitch: 60, speed: 180, amplitude: 110 },    // Math operators - higher pitch British voice
    type: { defaultVoice: 'en-gb-x-rp', pitch: 40, speed: 160, amplitude: 90 },   // Punctuation & symbols - lower pitch RP voice
    comment: { defaultVoice: 'en-us', pitch: 45, speed: 165, amplitude: 85 },      // Comments - softer US voice
    
    // Future semantic categories
    keyword: { defaultVoice: 'en-gb', pitch: 55, speed: 170, amplitude: 105 },                // Keywords - British voice
    'keyword.control': { defaultVoice: 'en-gb', pitch: 55, speed: 170, amplitude: 105 },
    'keyword.operator': { defaultVoice: 'en-gb', pitch: 60, speed: 180, amplitude: 110 },
    'keyword.import': { defaultVoice: 'en-gb-scotland', pitch: 48, speed: 165, amplitude: 95 },
    
    'function.name': { defaultVoice: 'en-us', pitch: 52, speed: 175, amplitude: 100 },
    'function.call': { defaultVoice: 'en-us', pitch: 50, speed: 175, amplitude: 100 },
    'function.builtin': { defaultVoice: 'en-gb', pitch: 58, speed: 180, amplitude: 105 },
    
    'string': { defaultVoice: 'en-us', pitch: 45, speed: 160, amplitude: 85 },
    'string.quoted': { defaultVoice: 'en-us', pitch: 45, speed: 160, amplitude: 85 },
    literal: { defaultVoice: 'en-us', pitch: 45, speed: 160, amplitude: 85 },
    
    'number': { defaultVoice: 'en-gb-x-rp', pitch: 55, speed: 185, amplitude: 100 },
    'number.integer': { defaultVoice: 'en-gb-x-rp', pitch: 55, speed: 185, amplitude: 100 },
    'number.float': { defaultVoice: 'en-gb-x-rp', pitch: 53, speed: 180, amplitude: 100 },
    
    'type.class': { defaultVoice: 'en-gb-scotland', pitch: 48, speed: 170, amplitude: 95 },
    'class.name': { defaultVoice: 'en-gb-scotland', pitch: 48, speed: 170, amplitude: 95 },
    'class.builtin': { defaultVoice: 'en-gb', pitch: 50, speed: 175, amplitude: 100 },
    
    'parameter': { defaultVoice: 'en-us', pitch: 52, speed: 175, amplitude: 95 },
    'parameter.name': { defaultVoice: 'en-us', pitch: 52, speed: 175, amplitude: 95 },
    'property': { defaultVoice: 'en-us', pitch: 50, speed: 175, amplitude: 100 },
    'property.name': { defaultVoice: 'en-us', pitch: 50, speed: 175, amplitude: 100 },
    
    'punctuation': { defaultVoice: 'en-gb-x-rp', pitch: 40, speed: 200, amplitude: 80 },
    'punctuation.bracket': { defaultVoice: 'en-gb-x-rp', pitch: 40, speed: 200, amplitude: 80 },
    'punctuation.delimiter': { defaultVoice: 'en-gb-x-rp', pitch: 38, speed: 210, amplitude: 75 },
    
    'constant': { defaultVoice: 'en-gb', pitch: 55, speed: 170, amplitude: 100 },
    'constant.builtin': { defaultVoice: 'en-gb', pitch: 55, speed: 170, amplitude: 100 },
    
    'namespace': { defaultVoice: 'en-gb-scotland', pitch: 48, speed: 165, amplitude: 95 },
    'module': { defaultVoice: 'en-gb-scotland', pitch: 48, speed: 165, amplitude: 95 },
    
    'special': { defaultVoice: 'en-us', pitch: 65, speed: 190, amplitude: 120 },   // Special characters - higher energy
    
    'text': { defaultVoice: 'en-us', pitch: 50, speed: 175, amplitude: 100 },
    'default': { defaultVoice: 'en-us', pitch: 50, speed: 175, amplitude: 100 },
};

// OpenAI TTS voice mapping for different categories (Korean voices)
export const openaiCategoryVoiceMap: Record<string, Partial<OpenAITTSConfig>> = {
    // Different voices and settings for semantic categories using OpenAI TTS
    // OpenAI TTS voices: alloy, echo, fable, onyx, nova, shimmer
    
    variable: { voice: 'alloy', speed: 1.0 },       // Variables, function names - clear neutral voice
    operator: { voice: 'echo', speed: 1.1 },        // Math operators - slightly faster, distinct voice
    type: { voice: 'fable', speed: 0.9 },           // Punctuation & symbols - slower, softer voice
    comment: { voice: 'nova', speed: 0.8 },         // Comments - slower, gentle voice
    
    // Future semantic categories
    keyword: { voice: 'onyx', speed: 1.0 },                        // Keywords - strong voice
    'keyword.control': { voice: 'onyx', speed: 1.0 },
    'keyword.operator': { voice: 'echo', speed: 1.1 },
    'keyword.import': { voice: 'shimmer', speed: 0.9 },
    
    'function.name': { voice: 'alloy', speed: 1.0 },
    'function.call': { voice: 'alloy', speed: 1.0 },
    'function.builtin': { voice: 'echo', speed: 1.1 },
    
    'string': { voice: 'nova', speed: 0.8 },
    'string.quoted': { voice: 'nova', speed: 0.8 },
    literal: { voice: 'nova', speed: 0.8 },
    
    'number': { voice: 'fable', speed: 1.2 },
    'number.integer': { voice: 'fable', speed: 1.2 },
    'number.float': { voice: 'fable', speed: 1.1 },
    
    'type.class': { voice: 'shimmer', speed: 0.9 },
    'class.name': { voice: 'shimmer', speed: 0.9 },
    'class.builtin': { voice: 'onyx', speed: 1.0 },
    
    'parameter': { voice: 'alloy', speed: 1.0 },
    'parameter.name': { voice: 'alloy', speed: 1.0 },
    'property': { voice: 'alloy', speed: 1.0 },
    'property.name': { voice: 'alloy', speed: 1.0 },
    
    'punctuation': { voice: 'fable', speed: 1.5 },
    'punctuation.bracket': { voice: 'fable', speed: 1.5 },
    'punctuation.delimiter': { voice: 'fable', speed: 1.6 },
    
    'constant': { voice: 'onyx', speed: 1.0 },
    'constant.builtin': { voice: 'onyx', speed: 1.0 },
    
    'namespace': { voice: 'shimmer', speed: 0.9 },
    'module': { voice: 'shimmer', speed: 0.9 },
    
    'special': { voice: 'echo', speed: 1.3 },   // Special characters - faster, more energetic
    
    'text': { voice: 'alloy', speed: 1.0 },
    'default': { voice: 'alloy', speed: 1.0 },
};

// Allow runtime switching of TTS backend & config
export function setBackend(backend: TTSBackend, sileroPartial?: Partial<SileroConfig>, espeakPartial?: Partial<EspeakConfig>, openaiPartial?: Partial<OpenAITTSConfig>) {
    currentBackend = backend;
    if (backend === TTSBackend.Silero && sileroPartial) {
        sileroConfig = { ...sileroConfig, ...sileroPartial };
    } else if (backend === TTSBackend.Espeak && espeakPartial) {
        espeakConfig = { ...espeakConfig, ...espeakPartial };
    } else if (backend === TTSBackend.OpenAI && openaiPartial) {
        openaiTTSConfig = { ...openaiTTSConfig, ...openaiPartial };
    }
}

// Allow runtime switching of ASR backend & config
export function setASRBackend(backend: ASRBackend, sileroASRPartial?: Partial<SileroASRConfig>, gpt4oASRPartial?: Partial<GPT4oASRConfig>) {
    currentASRBackend = backend;
    if (backend === ASRBackend.Silero && sileroASRPartial) {
        sileroASRConfig = { ...sileroASRConfig, ...sileroASRPartial };
    } else if (backend === ASRBackend.GPT4o && gpt4oASRPartial) {
        gpt4oASRConfig = { ...gpt4oASRConfig, ...gpt4oASRPartial };
    }
}

// Allow runtime switching of LLM backend & config
export function setLLMBackend(backend: LLMBackend, claudePartial?: Partial<ClaudeConfig>) {
    currentLLMBackend = backend;
    if (backend === LLMBackend.Claude && claudePartial) {
        claudeConfig = { ...claudeConfig, ...claudePartial };
    }
}

// Path and Etc Config ─────────────────────────────────────────────────────
export const config = {
    typingSpeechEnabled: true,  // global flag for typing speech
    cursorLineReadingEnabled: true,  // enable automatic line reading when cursor moves
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
    cursorLineReadingEnabled: boolean;
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

// Load configuration from VS Code settings
export function loadConfigFromSettings() {
    try {
        const vscode = require('vscode');
        
        // Check if workspace is available
        if (!vscode.workspace) {
            console.warn('[Config] VS Code workspace not available, using defaults');
            return;
        }
        
        const config = vscode.workspace.getConfiguration('lipcoder');
        
        // Load OpenAI API key for GPT-4o ASR
        const apiKey = config.get('openaiApiKey', '') as string;
        if (apiKey) {
            gpt4oASRConfig.apiKey = apiKey;
        }
        
        // Load ASR backend selection
        const asrBackend = config.get('asrBackend', 'gpt4o-transcribe') as string;
        if (asrBackend === 'silero') {
            currentASRBackend = ASRBackend.Silero;
        } else if (asrBackend === 'gpt4o-transcribe') {
            currentASRBackend = ASRBackend.GPT4o;
        }
        
        // Load Whisper model
        const whisperModel = config.get('gpt4oModel', 'whisper-1') as string;
        gpt4oASRConfig.model = whisperModel;
        
        // Load ASR language (null for auto-detection, 'en' for English, 'ko' for Korean, etc.)
        const asrLanguage = config.get('asrLanguage', null) as string | null;
        gpt4oASRConfig.language = asrLanguage;
        
        // Load OpenAI TTS configuration
        if (apiKey) {
            openaiTTSConfig.apiKey = apiKey; // Reuse OpenAI API key for TTS
        }
        
        const ttsModel = config.get('openaiTTSModel', 'tts-1') as string;
        openaiTTSConfig.model = ttsModel;
        
        const ttsVoice = config.get('openaiTTSVoice', 'alloy') as string;
        openaiTTSConfig.voice = ttsVoice;
        
        const ttsLanguage = config.get('openaiTTSLanguage', 'ko') as string;
        openaiTTSConfig.language = ttsLanguage;
        
        const ttsSpeed = config.get('openaiTTSSpeed', 1.0) as number;
        openaiTTSConfig.speed = ttsSpeed;
        
        const ttsVolumeBoost = config.get('openaiTTSVolumeBoost', 1.3) as number;
        openaiTTSConfig.volumeBoost = ttsVolumeBoost;
        
        // Load LLM backend selection
        const llmBackend = config.get('llmBackend', 'claude') as string;
        if (llmBackend === 'chatgpt') {
            currentLLMBackend = LLMBackend.ChatGPT;
        } else if (llmBackend === 'claude') {
            currentLLMBackend = LLMBackend.Claude;
        }
        
        // Load Claude configuration
        const claudeApiKey = config.get('claudeApiKey', '') as string;
        if (claudeApiKey) {
            claudeConfig.apiKey = claudeApiKey;
        }
        
        const claudeModel = config.get('claudeModel', 'claude-sonnet-4-20250514') as string;
        claudeConfig.model = claudeModel;
        
        const claudeMaxTokens = config.get('claudeMaxTokens', 2000) as number;
        claudeConfig.maxTokens = claudeMaxTokens;
        
        const claudeTemperature = config.get('claudeTemperature', 0.1) as number;
        claudeConfig.temperature = claudeTemperature;
        
        console.log('[Config] Configuration loaded successfully');
    } catch (error) {
        console.error('[Config] Failed to load configuration from VS Code settings:', error);
        // Use defaults on error
    }
}

const specialMap: Record<string, string> =  {
    '!': 'excitation.pcm', '@': 'at.pcm', '#': 'sharp.pcm', '$': 'dollar.pcm',
    '%': 'percent.pcm', '^': 'caret.pcm', '&': 'ampersand.pcm', '*': 'asterisk.pcm',
    '+': 'plus.pcm', '~': 'tilde.pcm', '|': 'bar.pcm', '?': 'question.pcm',
    '₩': 'won.pcm', '=': 'equals.pcm', '`': 'backtick.pcm', '\\': 'backslash.pcm',
};
