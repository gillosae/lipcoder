#!/usr/bin/env python3
"""
Hugging Face Whisper ASR Server
Local Whisper model using Hugging Face Transformers for speech recognition
"""

import os
import sys
import logging
import tempfile
import traceback
import re
from pathlib import Path
from typing import Optional, Dict, Any, List

import torch
import torchaudio
from flask import Flask, request, jsonify
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
import numpy as np

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(levelname)s:%(name)s:%(message)s'
)
logger = logging.getLogger(__name__)

# Flask app
app = Flask(__name__)

# Global variables
whisper_pipeline = None
device = None
torch_dtype = None

def setup_whisper_model():
    """Initialize Hugging Face Whisper model"""
    global whisper_pipeline, device, torch_dtype
    
    try:
        # Determine device and dtype
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        torch_dtype = torch.float16 if torch.cuda.is_available() else torch.float32
        
        logger.info(f"🤖 Using device: {device}")
        logger.info(f"🔢 Using dtype: {torch_dtype}")
        
        # Model configuration (using smaller model for faster loading)
        model_id = "openai/whisper-small"
        
        logger.info(f"📥 Loading Whisper model: {model_id}")
        
        # Load model and processor
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            model_id, 
            torch_dtype=torch_dtype, 
            low_cpu_mem_usage=True, 
            use_safetensors=True
        )
        model.to(device)
        
        processor = AutoProcessor.from_pretrained(model_id)
        
        # Create pipeline with optimized settings for minimal hallucination
        whisper_pipeline = pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            max_new_tokens=128,
            chunk_length_s=30,
            batch_size=16,
            return_timestamps=True,
            torch_dtype=torch_dtype,
            device=device,
        )
        
        logger.info("✅ Hugging Face Whisper model loaded successfully")
        return True
        
    except Exception as e:
        logger.error(f"❌ Failed to load Whisper model: {e}")
        logger.error(traceback.format_exc())
        return False

def filter_hallucinations(text: str) -> str:
    """
    Advanced hallucination filter for Whisper ASR output
    Filters common phrases, repetitive patterns, and noisy text
    """
    if not text or not text.strip():
        return ""
    
    text = text.strip()
    
    # Common hallucination phrases (Korean and English)
    hallucination_phrases = [
        # Korean common hallucinations
        "자막은 설정에서 선택하실 수 있습니다",
        "구독과 좋아요 부탁드립니다",
        "시청해주셔서 감사합니다",
        "다음 영상에서 만나요",
        "좋아요와 구독 부탁드려요",
        "구독 좋아요 부탁드립니다",
        "자막은 설정에서 선택하실수있습니다",
        "자막은 설정에서 선택하실 수가 있습니다",
        "시청해 주셔서 감사합니다",
        "감사합니다",
        "안녕하세요",
        "여러분 안녕하세요",
        
        # English common hallucinations
        "Thank you for watching",
        "Please like and subscribe",
        "Don't forget to hit the bell",
        "See you in the next video",
        "Thanks for your attention",
        "Please subscribe to my channel",
        "Please subscribe and like",
        "Subscribe and like",
        "Thanks for watching",
        "Don't forget to subscribe",
        "Hit the subscribe button",
        "Subtitles by",
        "Captions by",
        
        # Generic patterns
        "음악", "박수", "웃음",
        "Music", "Applause", "Laughter",
        "[음악]", "[박수]", "[웃음]",
        "[Music]", "[Applause]", "[Laughter]"
    ]
    
    # 1. Common phrase filtering
    text_lower = text.lower()
    for phrase in hallucination_phrases:
        if phrase.lower() in text_lower:
            logger.info(f"🚫 [HF-Whisper] Filtered hallucination phrase: '{phrase}'")
            return ""
    
    # 2. Length-based filtering
    if len(text) < 2:
        logger.info(f"🚫 [HF-Whisper] Text too short: '{text}'")
        return ""
    
    if len(text) > 1000:
        logger.info(f"🚫 [HF-Whisper] Text too long: {len(text)} characters")
        return ""
    
    # 3. Repetitive pattern filtering (word level) - Remove duplicates, keep one
    words = text.split()
    if len(words) > 1:
        word_counts = {}
        total_words = 0
        
        for word in words:
            if len(word) >= 3:  # Only count words with 3+ characters
                word_counts[word] = word_counts.get(word, 0) + 1
                total_words += 1
        
        if total_words > 0:
            max_repetitions = max(word_counts.values()) if word_counts else 0
            repetition_ratio = max_repetitions / total_words
            
            if repetition_ratio > 0.6:  # 60% repetition threshold
                # Instead of returning empty, remove duplicates and keep one instance
                unique_words = []
                seen = set()
                for word in words:
                    # Keep all short words (< 3 chars) and first occurrence of longer words
                    if len(word) < 3 or word not in seen:
                        unique_words.append(word)
                        if len(word) >= 3:  # Only track longer words for deduplication
                            seen.add(word)
                
                deduplicated_text = ' '.join(unique_words)
                logger.info(f"🔄 [HF-Whisper] Removed repetitive pattern: '{text}' → '{deduplicated_text}'")
                text = deduplicated_text
    
    # 4. Repetitive pattern filtering (character level) - Only for extreme cases
    chars = re.sub(r'\s+', '', text)  # Remove whitespace
    if len(chars) > 0:
        char_counts = {}
        for char in chars:
            char_counts[char] = char_counts.get(char, 0) + 1
        
        max_char_repetitions = max(char_counts.values()) if char_counts else 0
        char_repetition_ratio = max_char_repetitions / len(chars)
        
        # Only filter if it's extremely repetitive (90%+) and short
        if char_repetition_ratio > 0.9 and len(text) < 10:
            logger.info(f"🚫 [HF-Whisper] Filtered extreme character repetition: ratio={char_repetition_ratio:.2f}")
            return ""
        elif char_repetition_ratio > 0.6:
            logger.info(f"⚠️ [HF-Whisper] High character repetition detected but keeping text: ratio={char_repetition_ratio:.2f}")
    
    # 5. Special character filtering
    special_chars = len([c for c in text if not re.match(r'[a-zA-Z0-9가-힣\s]', c)])
    special_char_ratio = special_chars / len(text) if len(text) > 0 else 0
    
    if special_char_ratio > 0.5:  # 50% special characters threshold
        logger.info(f"🚫 [HF-Whisper] Too many special chars: ratio={special_char_ratio:.2f}")
        return ""
    
    # 6. Consecutive repetition filtering (same word 3+ times in a row) - Remove extras, keep one
    words = text.split()  # Re-split in case text was modified above
    if len(words) >= 3:
        cleaned_words = []
        i = 0
        while i < len(words):
            current_word = words[i]
            cleaned_words.append(current_word)
            
            # Skip consecutive identical words
            consecutive_count = 1
            while i + consecutive_count < len(words) and words[i + consecutive_count] == current_word:
                consecutive_count += 1
            
            if consecutive_count >= 3:
                logger.info(f"🔄 [HF-Whisper] Removed consecutive repetition: '{current_word}' (appeared {consecutive_count} times)")
            
            i += consecutive_count
        
        if len(cleaned_words) != len(words):
            text = ' '.join(cleaned_words)
            logger.info(f"🔄 [HF-Whisper] Cleaned consecutive repetitions: '{' '.join(words)}' → '{text}'")
    
    logger.info(f"✅ [HF-Whisper] Text passed hallucination filter: '{text}'")
    return text

def preprocess_audio(audio_path: str, target_sample_rate: int = 16000) -> Optional[np.ndarray]:
    """Preprocess audio file for Whisper"""
    try:
        # Load audio using torchaudio
        audio_data = torchaudio.load(audio_path)
        
        # Ensure we got a tuple (waveform, sample_rate)
        if not isinstance(audio_data, tuple) or len(audio_data) != 2:
            logger.error(f"❌ Unexpected audio data format: {type(audio_data)}")
            return None
            
        waveform, sample_rate = audio_data
        
        # Ensure waveform is a tensor
        if not isinstance(waveform, torch.Tensor):
            logger.error(f"❌ Waveform is not a tensor: {type(waveform)}")
            return None
        
        logger.info(f"🎵 Loaded audio: {waveform.shape}, sample_rate={sample_rate}")
        
        # Convert to mono if stereo
        if waveform.shape[0] > 1:
            waveform = torch.mean(waveform, dim=0, keepdim=True)
            logger.info("🔄 Converted stereo to mono")
        
        # Resample if necessary
        if sample_rate != target_sample_rate:
            resampler = torchaudio.transforms.Resample(sample_rate, target_sample_rate)
            waveform = resampler(waveform)
            logger.info(f"🔄 Resampled from {sample_rate}Hz to {target_sample_rate}Hz")
        
        # Ensure waveform is still a tensor before calling squeeze
        if not isinstance(waveform, torch.Tensor):
            logger.error(f"❌ Waveform became non-tensor after resampling: {type(waveform)}")
            return None
        
        # Convert to numpy array and normalize
        audio_array = waveform.squeeze().numpy()
        
        # Normalize to [-1, 1] range
        if audio_array.dtype != np.float32:
            if audio_array.dtype == np.int16:
                audio_array = audio_array.astype(np.float32) / 32768.0
            elif audio_array.dtype == np.int32:
                audio_array = audio_array.astype(np.float32) / 2147483648.0
            else:
                audio_array = audio_array.astype(np.float32)
        
        # Ensure proper range
        audio_array = np.clip(audio_array, -1.0, 1.0)
        
        logger.info(f"✅ Audio preprocessed: shape={audio_array.shape}, dtype={audio_array.dtype}, range=[{audio_array.min():.3f}, {audio_array.max():.3f}]")
        
        return audio_array
        
    except Exception as e:
        logger.error(f"❌ Audio preprocessing failed: {e}")
        logger.error(traceback.format_exc())
        return None

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    global whisper_pipeline
    
    status = {
        'status': 'healthy' if whisper_pipeline is not None else 'unhealthy',
        'model_loaded': whisper_pipeline is not None,
        'device': str(device) if device else 'unknown',
        'torch_dtype': str(torch_dtype) if torch_dtype else 'unknown'
    }
    
    return jsonify(status), 200 if whisper_pipeline else 503

@app.route('/asr', methods=['POST'])
def transcribe_audio():
    """Main ASR endpoint"""
    global whisper_pipeline
    
    if whisper_pipeline is None:
        return jsonify({
            'error': 'Whisper model not loaded',
            'details': 'Server initialization failed'
        }), 503
    
    try:
        # Check if audio file is provided (support both 'audio' and 'audio_file' fields)
        audio_file = None
        if 'audio_file' in request.files:
            audio_file = request.files['audio_file']
        elif 'audio' in request.files:
            audio_file = request.files['audio']
        
        if audio_file is None:
            return jsonify({
                'error': 'No audio file provided',
                'details': 'Please provide an audio file in the "audio_file" or "audio" field'
            }), 400
        if audio_file.filename == '':
            return jsonify({
                'error': 'Empty audio file',
                'details': 'Audio file is empty'
            }), 400
        
        # Get language parameter (optional)
        language = request.form.get('language', None)
        if language == 'auto' or language == '':
            language = None
        
        logger.info(f"🎤 Processing audio file: {audio_file.filename}")
        logger.info(f"🌍 Language constraint: {language if language else 'auto-detect'}")
        
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix='.wav') as temp_file:
            audio_file.save(temp_file.name)
            temp_audio_path = temp_file.name
        
        try:
            # Preprocess audio
            audio_array = preprocess_audio(temp_audio_path)
            if audio_array is None:
                return jsonify({
                    'error': 'Audio preprocessing failed',
                    'details': 'Could not process the audio file'
                }), 400
            
            # Prepare pipeline arguments with anti-hallucination settings
            # Note: Some parameters may not be supported by the ASR pipeline
            generate_kwargs = {}
            
            # Add language constraint if specified
            if language:
                generate_kwargs["language"] = language
                logger.info(f"🌍 Using language constraint: {language}")
            
            # Add temperature for conservative output (if supported)
            try:
                generate_kwargs["temperature"] = 0.0
                logger.info("🎯 Temperature set to 0.0 for anti-hallucination")
            except:
                logger.info("⚠️ Temperature parameter not supported by this pipeline")
            
            # Transcribe using Whisper pipeline
            logger.info("🔄 Starting transcription...")
            logger.info(f"🎯 Generate kwargs: {generate_kwargs}")
            
            # Try transcription with error handling for unsupported parameters
            try:
                result = whisper_pipeline(
                    audio_array,
                    generate_kwargs=generate_kwargs
                )
            except Exception as pipeline_error:
                logger.warning(f"⚠️ Pipeline failed with generate_kwargs, trying without: {pipeline_error}")
                # Fallback: try without generate_kwargs
                result = whisper_pipeline(audio_array)
            
            # Extract text from result
            if isinstance(result, dict) and 'text' in result:
                transcription = result['text'].strip()
            elif isinstance(result, list) and len(result) > 0 and 'text' in result[0]:
                transcription = result[0]['text'].strip()
            else:
                transcription = str(result).strip() if result else ""
            
            # Apply hallucination filtering
            transcription = filter_hallucinations(transcription)
            
            logger.info(f"✅ Transcription completed: '{transcription}' (length: {len(transcription)})")
            
            # Return result
            response = {
                'text': transcription,
                'language_detected': language if language else 'auto',
                'model': 'openai/whisper-large-v3',
                'processing_time': 'N/A'  # Could add timing if needed
            }
            
            return jsonify(response), 200
            
        finally:
            # Clean up temporary file
            try:
                os.unlink(temp_audio_path)
            except:
                pass
    
    except Exception as e:
        logger.error(f"❌ Transcription error: {e}")
        logger.error(traceback.format_exc())
        
        return jsonify({
            'error': 'Transcription failed',
            'details': str(e)
        }), 500

@app.route('/models', methods=['GET'])
def list_models():
    """List available models"""
    return jsonify({
        'models': ['openai/whisper-small'],
        'current_model': 'openai/whisper-small',
        'device': str(device) if device else 'unknown'
    })

if __name__ == '__main__':
    print("🤗 Starting Hugging Face Whisper ASR Server...")
    print("🐍 Setting up Python environment...")
    
    # Check Python version
    python_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    print(f"🐍 Python version: {python_version}")
    
    # Check PyTorch
    print(f"🔥 PyTorch version: {torch.__version__}")
    print(f"🎯 CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"🎯 CUDA device: {torch.cuda.get_device_name()}")
    
    # Initialize Whisper model
    print("🤖 Loading Hugging Face Whisper model...")
    if not setup_whisper_model():
        print("❌ Failed to initialize Whisper model")
        sys.exit(1)
    
    print("📡 Starting server on port 5005...")
    print("🚀 Hugging Face Whisper ASR Server ready!")
    print("📝 Logs will appear below...")
    print("   Press Ctrl+C to stop the server")
    
    # Start Flask server
    app.run(
        host='0.0.0.0',
        port=5005,
        debug=False,
        threaded=True
    )
