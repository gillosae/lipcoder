from flask import Flask, request, send_file, jsonify
import torch
import uuid
import os
import numpy as np
import soundfile as sf
import tempfile
import subprocess
import re
import logging
import sys
import contextlib
import json
import time
import hashlib
from io import StringIO
from pathlib import Path

# Configure logging to suppress verbose TTS output
logging.getLogger().setLevel(logging.ERROR)  # Set root logger to ERROR
logging.getLogger("TTS").setLevel(logging.ERROR)
logging.getLogger("TTS.tts.models.xtts").setLevel(logging.ERROR)
logging.getLogger("TTS.tts.configs.xtts_config").setLevel(logging.ERROR)
logging.getLogger("TTS.api").setLevel(logging.ERROR)
logging.getLogger("TTS.utils").setLevel(logging.ERROR)
logging.getLogger("TTS.vocoder").setLevel(logging.ERROR)
logging.getLogger("torch").setLevel(logging.ERROR)
logging.getLogger("transformers").setLevel(logging.ERROR)

@contextlib.contextmanager
def suppress_stdout():
    """Context manager to suppress stdout output"""
    with open(os.devnull, "w") as devnull:
        old_stdout = sys.stdout
        sys.stdout = devnull
        try:
            yield
        finally:
            sys.stdout = old_stdout

app = Flask(__name__)

# Voice mapping for different code categories with language support
VOICE_MAPPING = {
    'comment': {'en': 'comment_eng.wav', 'ko': 'comment_kor.wav'},
    'keyword': {'en': 'keyword_eng.wav', 'ko': 'keyword_kor.wav'}, 
    'literal': {'en': 'literal_eng.wav', 'ko': 'literal_kor.wav'},
    'operator': {'en': 'operator_eng.wav', 'ko': 'operator_kor.wav'},
    'type': {'en': 'type_eng.wav', 'ko': 'type_kor.wav'},
    'variable': {'en': 'variable_eng.wav', 'ko': 'variable_kor.wav'},
    'default': {'en': 'variable_eng.wav', 'ko': 'variable_kor.wav'}  # Default voice for unknown categories
}

# Speaker embedding cache for fast voice switching
class SpeakerEmbeddingCache:
    def __init__(self, cache_dir="/tmp/xtts_speaker_cache"):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(exist_ok=True)
        self.embeddings = {}  # In-memory cache: {file_hash: embedding_tensor}
        self.metadata = {}    # Metadata: {file_hash: {path, mtime, category}}
        self.cache_file = self.cache_dir / "embedding_cache.json"
        self.load_cache_metadata()
        
    def get_file_hash(self, file_path):
        """Generate hash for audio file based on path and modification time"""
        stat = os.stat(file_path)
        content = f"{file_path}_{stat.st_mtime}_{stat.st_size}"
        return hashlib.md5(content.encode()).hexdigest()
    
    def load_cache_metadata(self):
        """Load cache metadata from disk"""
        try:
            if self.cache_file.exists():
                with open(self.cache_file, 'r') as f:
                    self.metadata = json.load(f)
                print(f"Loaded {len(self.metadata)} cached speaker embeddings")
        except Exception as e:
            print(f"Error loading cache metadata: {e}")
            self.metadata = {}
    
    def save_cache_metadata(self):
        """Save cache metadata to disk"""
        try:
            with open(self.cache_file, 'w') as f:
                json.dump(self.metadata, f, indent=2)
        except Exception as e:
            print(f"Error saving cache metadata: {e}")
    
    def get_embedding_file_path(self, file_hash):
        """Get path for cached embedding file"""
        return self.cache_dir / f"{file_hash}.pt"
    
    def extract_speaker_embedding(self, audio_path, model, config):
        """Extract speaker embedding from audio file using XTTS model"""
        try:
            start_time = time.time()
            
            # Use the model's get_conditioning_latents method for embedding extraction
            gpt_cond_latent, speaker_embedding = model.get_conditioning_latents(
                audio_path=audio_path,
                gpt_cond_len=config.gpt_cond_len if hasattr(config, 'gpt_cond_len') else 3,
                gpt_cond_chunk_len=config.gpt_cond_chunk_len if hasattr(config, 'gpt_cond_chunk_len') else 4,
                max_ref_length=config.max_ref_len if hasattr(config, 'max_ref_len') else 60
            )
            
            extraction_time = time.time() - start_time
            print(f"Speaker embedding extracted in {extraction_time:.3f}s for {audio_path}")
            
            return {
                'gpt_cond_latent': gpt_cond_latent,
                'speaker_embedding': speaker_embedding,
                'extraction_time': extraction_time
            }
            
        except Exception as e:
            print(f"Error extracting speaker embedding from {audio_path}: {e}")
            return None
    
    def cache_speaker_embedding(self, audio_path, model, config, category=None):
        """Cache speaker embedding for an audio file"""
        if not os.path.exists(audio_path):
            print(f"Audio file not found: {audio_path}")
            return None
            
        file_hash = self.get_file_hash(audio_path)
        embedding_path = self.get_embedding_file_path(file_hash)
        
        # Check if already cached and up-to-date
        if file_hash in self.metadata and embedding_path.exists():
            try:
                # Load from disk cache
                cached_data = torch.load(embedding_path, map_location=device)
                self.embeddings[file_hash] = cached_data
                print(f"Loaded cached embedding for {audio_path} (category: {category})")
                return cached_data
            except Exception as e:
                print(f"Error loading cached embedding: {e}")
        
        # Extract new embedding
        embedding_data = self.extract_speaker_embedding(audio_path, model, config)
        if embedding_data is None:
            return None
        
        try:
            # Save to disk cache
            torch.save(embedding_data, embedding_path)
            
            # Store in memory cache
            self.embeddings[file_hash] = embedding_data
            
            # Update metadata
            self.metadata[file_hash] = {
                'path': audio_path,
                'mtime': os.path.getmtime(audio_path),
                'category': category,
                'extraction_time': embedding_data['extraction_time']
            }
            
            # Save metadata
            self.save_cache_metadata()
            
            print(f"Cached speaker embedding for {audio_path} (category: {category})")
            return embedding_data
            
        except Exception as e:
            print(f"Error caching speaker embedding: {e}")
            return embedding_data  # Return the data even if caching failed
    
    def get_cached_embedding(self, audio_path):
        """Get cached speaker embedding for an audio file"""
        if not os.path.exists(audio_path):
            return None
            
        file_hash = self.get_file_hash(audio_path)
        
        # Check memory cache first
        if file_hash in self.embeddings:
            return self.embeddings[file_hash]
        
        # Check disk cache
        embedding_path = self.get_embedding_file_path(file_hash)
        if file_hash in self.metadata and embedding_path.exists():
            try:
                cached_data = torch.load(embedding_path, map_location=device)
                self.embeddings[file_hash] = cached_data  # Load into memory
                return cached_data
            except Exception as e:
                print(f"Error loading cached embedding: {e}")
        
        return None
    
    def preload_voice_embeddings(self, model, config):
        """Preload all voice embeddings on server startup"""
        voices_dir = Path(__file__).parent / "voices"
        if not voices_dir.exists():
            print("Voices directory not found, skipping preload")
            return
        
        print("Preloading speaker embeddings for all voices (Korean and English)...")
        start_time = time.time()
        
        for category, voice_mapping in VOICE_MAPPING.items():
            if isinstance(voice_mapping, dict):
                # New format with language support
                for language, voice_file in voice_mapping.items():
                    voice_path = voices_dir / voice_file
                    if voice_path.exists():
                        cache_key = f"{category}_{language}"
                        print(f"Preloading embedding for {cache_key}: {voice_file}")
                        self.cache_speaker_embedding(str(voice_path), model, config, cache_key)
                    else:
                        print(f"Voice file not found: {voice_path}")
            else:
                # Legacy format (single voice file)
                voice_path = voices_dir / voice_mapping
                if voice_path.exists():
                    print(f"Preloading embedding for {category}: {voice_mapping}")
                    self.cache_speaker_embedding(str(voice_path), model, config, category)
                else:
                    print(f"Voice file not found: {voice_path}")
        
        total_time = time.time() - start_time
        print(f"Preloaded {len(self.embeddings)} speaker embeddings in {total_time:.3f}s")
    
    def get_cache_stats(self):
        """Get cache statistics"""
        return {
            'cached_embeddings': len(self.embeddings),
            'metadata_entries': len(self.metadata),
            'cache_dir': str(self.cache_dir),
            'total_extraction_time': sum(
                meta.get('extraction_time', 0) for meta in self.metadata.values()
            )
        }

# Global speaker embedding cache
speaker_cache = SpeakerEmbeddingCache()

def get_speaker_voice(category=None, language='en'):
    """Get the appropriate speaker voice file based on code category and language."""
    voices_dir = Path(__file__).parent / "voices"
    
    # Determine voice file based on category and language
    if category and category in VOICE_MAPPING:
        voice_mapping = VOICE_MAPPING[category]
    else:
        voice_mapping = VOICE_MAPPING['default']
    
    # Get language-specific voice file
    if isinstance(voice_mapping, dict):
        # New format with language support
        if language in voice_mapping:
            voice_file = voice_mapping[language]
        else:
            # Fallback to English if language not found
            voice_file = voice_mapping.get('en', list(voice_mapping.values())[0])
    else:
        # Legacy format (single voice file)
        voice_file = voice_mapping
    
    voice_path = voices_dir / voice_file
    
    # Check if the voice file exists
    if voice_path.exists():
        print(f"Using voice: {voice_file} for category: {category or 'default'}, language: {language}")
        return str(voice_path)
    else:
        print(f"Voice file not found: {voice_path}, trying fallbacks")
        
        # Try to find any available voice file as fallback
        for cat_mapping in VOICE_MAPPING.values():
            if isinstance(cat_mapping, dict):
                for lang_voice in cat_mapping.values():
                    fallback_path = voices_dir / lang_voice
                    if fallback_path.exists():
                        print(f"Using fallback voice: {lang_voice}")
                        return str(fallback_path)
            else:
                fallback_path = voices_dir / cat_mapping
                if fallback_path.exists():
                    print(f"Using fallback voice: {cat_mapping}")
                    return str(fallback_path)
        
        print("No voice files found in voices directory")
        return None

# Initialize persistent XTTS-v2 model for Korean
device = 'cuda' if torch.cuda.is_available() else 'cpu'
print(f"Using device: {device}")

# Load the Coqui XTTS-v2 model directly
model_name = "tts_models/multilingual/multi-dataset/xtts_v2"
print(f"Loading XTTS-v2 model: {model_name}")

# Model paths
model_dir = "/Users/gillosae/Library/Application Support/tts/tts_models--multilingual--multi-dataset--xtts_v2"
config_path = f"{model_dir}/config.json"
checkpoint_dir = model_dir

tts = None
xtts_model = None
xtts_config = None

def load_model():
    global tts, xtts_model, xtts_config
    try:
        # Set environment variable to agree to Coqui TOS
        os.environ['COQUI_TOS_AGREED'] = '1'
        
        # Suppress verbose logging from various TTS components
        logging.getLogger("TTS.tts.models.xtts").setLevel(logging.ERROR)
        logging.getLogger("TTS.utils.generic_utils").setLevel(logging.ERROR)
        logging.getLogger("TTS.utils.audio").setLevel(logging.ERROR)
        logging.getLogger("TTS.vocoder.models").setLevel(logging.ERROR)
        logging.getLogger("torch").setLevel(logging.ERROR)
        
        # Suppress warnings
        import warnings
        warnings.filterwarnings("ignore", category=UserWarning)
        warnings.filterwarnings("ignore", category=FutureWarning)
        
        # Monkey patch torch.load to disable weights_only
        import torch
        original_load = torch.load
        
        def patched_load(*args, **kwargs):
            # Always set weights_only=False
            kwargs['weights_only'] = False
            return original_load(*args, **kwargs)
        
        torch.load = patched_load
        
        # Also patch torch.serialization if it exists
        try:
            import torch.serialization
            original_torch_load = torch.serialization.load
            
            def patched_serialization_load(*args, **kwargs):
                kwargs['weights_only'] = False
                return original_torch_load(*args, **kwargs)
            
            torch.serialization.load = patched_serialization_load
        except:
            pass
        
        # Load XTTS model directly
        from TTS.tts.configs.xtts_config import XttsConfig
        from TTS.tts.models.xtts import Xtts
        
        print("Loading XTTS-v2 model directly from config...")
        
        # Load config
        xtts_config = XttsConfig()
        xtts_config.load_json(config_path)
        print(f"Config loaded from: {config_path}")
        
        # Initialize model
        xtts_model = Xtts.init_from_config(xtts_config)
        print("Model initialized from config")
        
        # Load checkpoint
        xtts_model.load_checkpoint(xtts_config, checkpoint_dir=checkpoint_dir, eval=True)
        print(f"Checkpoint loaded from: {checkpoint_dir}")
        
        # Move to device
        if device == 'cuda':
            xtts_model.cuda()
        else:
            xtts_model.cpu()
        print(f"Model moved to device: {device}")
        
        # Also keep the TTS API for compatibility
        from TTS.api import TTS
        
        # Suppress additional verbose output during TTS initialization
        import warnings
        warnings.filterwarnings("ignore")
        
        # Set environment variable to reduce TTS verbosity
        os.environ['TTS_CACHE'] = '/tmp/tts_cache'
        
        with suppress_stdout():
            tts = TTS(
                model_name="tts_models/multilingual/multi-dataset/xtts_v2",
                progress_bar=False,
                gpu=(device == 'cuda')
            )
        
        # Restore original torch.load
        torch.load = original_load
        try:
            torch.serialization.load = original_torch_load
        except:
            pass
        
        if xtts_model is not None and tts is not None:
            print(f"XTTS-v2 model loaded successfully (direct + API) on {device} - VERSION 2024-08-19-v7")
            
            # Preload speaker embeddings for fast voice switching
            try:
                speaker_cache.preload_voice_embeddings(xtts_model, xtts_config)
            except Exception as e:
                print(f"Warning: Failed to preload speaker embeddings: {e}")
            
            return True
        else:
            print("XTTS-v2 model failed to load")
            return False
            
    except Exception as e:
        print(f"Error loading XTTS-v2 model: {e}")
        print(f"Exception type: {type(e)}")
        import traceback
        traceback.print_exc()
        tts = None
        xtts_model = None
        xtts_config = None
        
        # Restore original torch.load in case of error
        try:
            torch.load = original_load
            torch.serialization.load = original_torch_load
        except:
            pass
        
        return False

# Load model on startup
load_model()

@app.route('/tts', methods=['POST'])
def tts_endpoint():
    global tts
    if tts is None:
        if not load_model():
            return jsonify({"error": "XTTS-v2 model not loaded"}), 500
    
    data = request.json
    text = data['text']
    sample_rate = data.get('sample_rate', 24000)  # XTTS-v2 outputs at 24kHz
    language = data.get('language', 'ko')  # Default to Korean
    speaker_wav = data.get('speaker_wav', None)  # Optional speaker reference
    category = data.get('category', None)  # Code category for voice selection
    
    # Auto-detect language only if not specified or set to 'auto'
    # Respect client's language choice when explicitly provided
    if language == 'auto' or not language or language == '':
        # Simple language detection based on character ranges
        korean_chars = sum(1 for c in text if '\uac00' <= c <= '\ud7a3')
        total_chars = len([c for c in text if c.isalpha()])
        if total_chars > 0 and korean_chars / total_chars > 0.3:
            language = 'ko'
        else:
            language = 'en'
        print(f"Auto-detected language: {language}")
    else:
        print(f"Using client-specified language: {language}")
    
    print(f"Generating TTS for text: '{text}' in language '{language}' at {sample_rate}Hz")
    print(f"[DEBUG] Language detection details: text='{text}', received_language='{data.get('language', 'not_provided')}', final_language='{language}'")
    # Debug statements removed to prevent verbose output
    
    try:
        # Generate temporary mono file
        mono_temp_path = os.path.join('/tmp', f"xtts_v2_mono_{uuid.uuid4().hex}.wav")
        
        # Use XTTS-v2 to generate speech
        # Determine speaker voice: use provided speaker_wav or get from category
        if speaker_wav and os.path.exists(speaker_wav):
            chosen_speaker_wav = speaker_wav
            print(f"Using provided speaker reference: {speaker_wav}")
        else:
            chosen_speaker_wav = get_speaker_voice(category, language)
            if chosen_speaker_wav:
                print(f"Using category-based speaker reference: {chosen_speaker_wav}")
            else:
                print("No speaker reference available")
        
        if chosen_speaker_wav and os.path.exists(chosen_speaker_wav):
            # Voice cloning mode with speaker reference
            print(f"Generating TTS with speaker cloning: {chosen_speaker_wav}")
            with suppress_stdout():
                tts.tts_to_file(
                    text=text,
                    file_path=mono_temp_path,
                    speaker_wav=chosen_speaker_wav,
                    language=language
                )
            print(f"[DEBUG] TTS synthesis completed with language='{language}'")
        else:
            # Use default speaker for the language - XTTS-v2 requires a speaker
            # Try common default speakers for XTTS-v2
            default_speakers = ["Claribel Dervla", "Daisy Studious", "Gracie Wise", "Tammie Ema"]
            
            # Get available speakers from the model
            available_speakers = []
            try:
                if hasattr(tts, 'speakers') and tts.speakers:
                    if isinstance(tts.speakers, list):
                        available_speakers = tts.speakers
                    elif isinstance(tts.speakers, dict):
                        available_speakers = list(tts.speakers.keys())
                    else:
                        available_speakers = [str(tts.speakers)]
                elif hasattr(tts, 'synthesizer') and hasattr(tts.synthesizer, 'tts_speakers_file'):
                    # Try to get speakers from synthesizer
                    available_speakers = getattr(tts.synthesizer, 'speakers', [])
            except Exception as e:
                print(f"Error getting speakers: {e}")
                available_speakers = []
            
            print(f"Available speakers: {available_speakers}")
            
            # Choose a speaker
            chosen_speaker = None
            if available_speakers:
                # Use first available speaker
                chosen_speaker = available_speakers[0]
            else:
                # Try common default speakers
                chosen_speaker = default_speakers[0]  # "Claribel Dervla"
            
            print(f"Using speaker '{chosen_speaker}' for language: {language}")
            try:
                with suppress_stdout():
                    tts.tts_to_file(
                        text=text,
                        file_path=mono_temp_path,
                        speaker=chosen_speaker,
                        language=language
                    )
                print(f"[DEBUG] TTS synthesis completed with speaker='{chosen_speaker}' and language='{language}'")
            except Exception as e:
                print(f"Error with speaker '{chosen_speaker}': {e}")
                # Try without speaker as last resort
                print("Trying without speaker as fallback...")
                with suppress_stdout():
                    tts.tts_to_file(
                        text=text,
                        file_path=mono_temp_path,
                        language=language
                    )
                print(f"[DEBUG] Fallback TTS synthesis completed with language='{language}'")
        
        # Convert mono to stereo if needed
        stereo_temp_path = os.path.join('/tmp', f"xtts_v2_stereo_{uuid.uuid4().hex}.wav")
        
        # Read the mono audio
        mono_audio, original_sr = sf.read(mono_temp_path)
        
        # Resample if requested sample rate is different from XTTS-v2's output (24kHz)
        if sample_rate != original_sr:
            import librosa
            mono_audio = librosa.resample(mono_audio, orig_sr=original_sr, target_sr=sample_rate)
            sr = sample_rate
        else:
            sr = original_sr
        
        # Convert mono to stereo by duplicating the channel
        if len(mono_audio.shape) == 1:  # Ensure it's mono
            stereo_audio = np.column_stack((mono_audio, mono_audio))
        else:
            stereo_audio = mono_audio  # Already stereo or multi-channel
        
        # Write as stereo
        sf.write(stereo_temp_path, stereo_audio, sr)
        
        # Clean up mono file
        if os.path.exists(mono_temp_path):
            os.remove(mono_temp_path)
        
        print(f"Generated audio file: {stereo_temp_path}")
        return send_file(stereo_temp_path, mimetype='audio/wav', as_attachment=False)
        
    except Exception as e:
        print(f"Error generating TTS: {e}")
        return jsonify({"error": f"TTS generation failed: {str(e)}"}), 500

@app.route('/health', methods=['GET'])
def health():
    cache_stats = speaker_cache.get_cache_stats()
    return jsonify({
        "status": "healthy",
        "model_loaded": tts is not None,
        "direct_model_loaded": xtts_model is not None,
        "device": device,
        "model_name": model_name,
        "config_path": config_path,
        "checkpoint_dir": checkpoint_dir,
        "supported_languages": ["en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru", "nl", "cs", "ar", "zh-cn", "ja", "hu", "ko", "hi"],
        "speaker_cache": cache_stats
    })

@app.route('/cache/stats', methods=['GET'])
def cache_stats():
    """Get detailed cache statistics"""
    stats = speaker_cache.get_cache_stats()
    
    # Add per-voice statistics
    voice_stats = {}
    for file_hash, metadata in speaker_cache.metadata.items():
        category = metadata.get('category', 'unknown')
        if category not in voice_stats:
            voice_stats[category] = {
                'count': 0,
                'total_extraction_time': 0,
                'files': []
            }
        voice_stats[category]['count'] += 1
        voice_stats[category]['total_extraction_time'] += metadata.get('extraction_time', 0)
        voice_stats[category]['files'].append({
            'path': metadata['path'],
            'extraction_time': metadata.get('extraction_time', 0)
        })
    
    stats['voice_stats'] = voice_stats
    return jsonify(stats)

@app.route('/cache/preload', methods=['POST'])
def cache_preload():
    """Manually trigger cache preloading"""
    global xtts_model, xtts_config
    if xtts_model is None or xtts_config is None:
        return jsonify({"error": "XTTS-v2 model not loaded"}), 500
    
    try:
        start_time = time.time()
        speaker_cache.preload_voice_embeddings(xtts_model, xtts_config)
        total_time = time.time() - start_time
        
        stats = speaker_cache.get_cache_stats()
        return jsonify({
            "status": "success",
            "preload_time": total_time,
            "cache_stats": stats
        })
    except Exception as e:
        return jsonify({"error": f"Preload failed: {str(e)}"}), 500

@app.route('/cache/clear', methods=['POST'])
def cache_clear():
    """Clear the speaker embedding cache"""
    try:
        # Clear memory cache
        speaker_cache.embeddings.clear()
        speaker_cache.metadata.clear()
        
        # Clear disk cache
        import shutil
        if speaker_cache.cache_dir.exists():
            shutil.rmtree(speaker_cache.cache_dir)
            speaker_cache.cache_dir.mkdir(exist_ok=True)
        
        return jsonify({"status": "success", "message": "Cache cleared"})
    except Exception as e:
        return jsonify({"error": f"Cache clear failed: {str(e)}"}), 500

@app.route('/tts_direct', methods=['POST'])
def tts_direct_endpoint():
    """
    Direct XTTS model synthesis endpoint using the model.synthesize method
    """
    global xtts_model, xtts_config
    if xtts_model is None or xtts_config is None:
        if not load_model():
            return jsonify({"error": "XTTS-v2 direct model not loaded"}), 500
    
    data = request.json
    text = data['text']
    sample_rate = data.get('sample_rate', 24000)
    language = data.get('language', 'en')
    speaker_wav = data.get('speaker_wav', None)
    category = data.get('category', None)
    gpt_cond_len = data.get('gpt_cond_len', 3)
    
    # Auto-detect language only if not specified or set to 'auto'
    # Respect client's language choice when explicitly provided
    if language == 'auto' or not language or language == '':
        korean_chars = sum(1 for c in text if '\uac00' <= c <= '\ud7a3')
        total_chars = len([c for c in text if c.isalpha()])
        if total_chars > 0 and korean_chars / total_chars > 0.3:
            language = 'ko'
        else:
            language = 'en'
        print(f"Auto-detected language: {language}")
    else:
        print(f"Using client-specified language: {language}")
    
    print(f"Direct synthesis for text: '{text}' in language '{language}' at {sample_rate}Hz")
    
    try:
        # Determine speaker voice
        if speaker_wav and os.path.exists(speaker_wav):
            chosen_speaker_wav = speaker_wav
            print(f"Using provided speaker reference: {speaker_wav}")
        else:
            chosen_speaker_wav = get_speaker_voice(category, language)
            if chosen_speaker_wav:
                print(f"Using category-based speaker reference: {chosen_speaker_wav}")
            else:
                print("No speaker reference available")
                return jsonify({"error": "Speaker reference required for direct synthesis"}), 400
        
        # Use direct model synthesis
        print(f"Direct synthesis with speaker: {chosen_speaker_wav}")
        outputs = xtts_model.synthesize(
            text,
            xtts_config,
            speaker_wav=chosen_speaker_wav,
            gpt_cond_len=gpt_cond_len,
            language=language,
        )
        
        # outputs is a dictionary with 'wav' key containing the audio array
        audio_array = outputs['wav']
        
        # Convert to numpy array if needed
        if hasattr(audio_array, 'cpu'):
            audio_array = audio_array.cpu().numpy()
        
        # Ensure it's a numpy array
        audio_array = np.array(audio_array)
        
        # The output is typically at 24kHz, resample if needed
        original_sr = 24000
        if sample_rate != original_sr:
            import librosa
            audio_array = librosa.resample(audio_array, orig_sr=original_sr, target_sr=sample_rate)
            sr = sample_rate
        else:
            sr = original_sr
        
        # Convert mono to stereo
        if len(audio_array.shape) == 1:
            stereo_audio = np.column_stack((audio_array, audio_array))
        else:
            stereo_audio = audio_array
        
        # Save to temporary file
        temp_path = os.path.join('/tmp', f"xtts_v2_direct_{uuid.uuid4().hex}.wav")
        sf.write(temp_path, stereo_audio, sr)
        
        print(f"Direct synthesis completed: {temp_path}")
        return send_file(temp_path, mimetype='audio/wav', as_attachment=False)
        
    except Exception as e:
        print(f"Error in direct synthesis: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Direct synthesis failed: {str(e)}"}), 500

@app.route('/tts_fast', methods=['POST'])
def tts_fast_endpoint():
    """
    Fast TTS synthesis using pre-cached speaker embeddings
    This endpoint minimizes latency by using cached speaker embeddings
    """
    global xtts_model, xtts_config
    if xtts_model is None or xtts_config is None:
        if not load_model():
            return jsonify({"error": "XTTS-v2 direct model not loaded"}), 500
    
    data = request.json
    text = data['text']
    sample_rate = data.get('sample_rate', 24000)
    language = data.get('language', 'en')
    speaker_wav = data.get('speaker_wav', None)
    category = data.get('category', None)
    
    # Auto-detect language only if not specified or set to 'auto'
    # Respect client's language choice when explicitly provided
    if language == 'auto' or not language or language == '':
        korean_chars = sum(1 for c in text if '\uac00' <= c <= '\ud7a3')
        total_chars = len([c for c in text if c.isalpha()])
        if total_chars > 0 and korean_chars / total_chars > 0.3:
            language = 'ko'
        else:
            language = 'en'
        print(f"Auto-detected language: {language}")
    else:
        print(f"Using client-specified language: {language}")
    
    print(f"Fast synthesis for text: '{text}' in language '{language}' at {sample_rate}Hz")
    print(f"[DEBUG] Language detection details: text='{text}', received_language='{data.get('language', 'not_provided')}', final_language='{language}'")
    
    try:
        start_time = time.time()
        
        # Determine speaker voice
        if speaker_wav and os.path.exists(speaker_wav):
            chosen_speaker_wav = speaker_wav
            print(f"Using provided speaker reference: {speaker_wav}")
        else:
            chosen_speaker_wav = get_speaker_voice(category, language)
            if chosen_speaker_wav:
                print(f"Using category-based speaker reference: {chosen_speaker_wav}")
            else:
                print("No speaker reference available")
                return jsonify({"error": "Speaker reference required for fast synthesis"}), 400
        
        # Try to get cached embedding first
        cached_embedding = speaker_cache.get_cached_embedding(chosen_speaker_wav)
        
        if cached_embedding:
            # Use cached embedding for ultra-fast synthesis
            print(f"Using cached embedding for {chosen_speaker_wav}")
            
            # Extract cached latents
            gpt_cond_latent = cached_embedding['gpt_cond_latent']
            speaker_embedding = cached_embedding['speaker_embedding']
            
            # Debug embedding shapes
            print(f"[DEBUG] Using cached embeddings - GPT shape: {gpt_cond_latent.shape if hasattr(gpt_cond_latent, 'shape') else 'unknown'}, Speaker shape: {speaker_embedding.shape if hasattr(speaker_embedding, 'shape') else 'unknown'}")
            
            # Perform synthesis with cached embeddings
            embedding_time = time.time()
            
            # Use the model's inference method directly with pre-computed embeddings
            # Use more conservative parameters to avoid gibberish output
            outputs = xtts_model.inference(
                text,
                language,
                gpt_cond_latent,
                speaker_embedding,
                temperature=0.75,
                length_penalty=1.0,
                repetition_penalty=2.0,  # Reduced from 5.0 - high values cause gibberish
                top_k=50,
                top_p=0.9,  # Slightly higher for better quality
                enable_text_splitting=True
            )
            print(f"[DEBUG] Inference parameters: temp=0.75, rep_penalty=2.0, top_p=0.9")
            
            synthesis_time = time.time() - embedding_time
            print(f"Fast synthesis completed in {synthesis_time:.3f}s (cached embedding)")
            print(f"[DEBUG] Fast synthesis used language='{language}' with cached embedding")
            
        else:
            # Fall back to regular synthesis with embedding extraction
            print(f"No cached embedding found, extracting and caching for {chosen_speaker_wav}")
            
            # Cache the embedding for future use
            embedding_data = speaker_cache.cache_speaker_embedding(
                chosen_speaker_wav, xtts_model, xtts_config, category
            )
            
            if embedding_data:
                gpt_cond_latent = embedding_data['gpt_cond_latent']
                speaker_embedding = embedding_data['speaker_embedding']
                
                # Perform synthesis
                embedding_time = time.time()
                # Use more conservative parameters to avoid gibberish output
                outputs = xtts_model.inference(
                    text,
                    language,
                    gpt_cond_latent,
                    speaker_embedding,
                    temperature=0.75,
                    length_penalty=1.0,
                    repetition_penalty=2.0,  # Reduced from 5.0 - high values cause gibberish
                    top_k=50,
                    top_p=0.9,  # Slightly higher for better quality
                    enable_text_splitting=True
                )
                print(f"[DEBUG] Inference parameters: temp=0.75, rep_penalty=2.0, top_p=0.9")
                
                synthesis_time = time.time() - embedding_time
                print(f"Synthesis with new embedding completed in {synthesis_time:.3f}s")
                print(f"[DEBUG] Fast synthesis with new embedding used language='{language}'")
            else:
                return jsonify({"error": "Failed to extract speaker embedding"}), 500
        
        # Process output audio
        audio_array = outputs['wav']
        
        # Convert to numpy array if needed
        if hasattr(audio_array, 'cpu'):
            audio_array = audio_array.cpu().numpy()
        
        # Ensure it's a numpy array
        audio_array = np.array(audio_array)
        
        # The output is typically at 24kHz, resample if needed
        original_sr = 24000
        if sample_rate != original_sr:
            import librosa
            audio_array = librosa.resample(audio_array, orig_sr=original_sr, target_sr=sample_rate)
            sr = sample_rate
        else:
            sr = original_sr
        
        # Convert mono to stereo
        if len(audio_array.shape) == 1:
            stereo_audio = np.column_stack((audio_array, audio_array))
        else:
            stereo_audio = audio_array
        
        # Save to temporary file
        temp_path = os.path.join('/tmp', f"xtts_v2_fast_{uuid.uuid4().hex}.wav")
        sf.write(temp_path, stereo_audio, sr)
        
        total_time = time.time() - start_time
        print(f"Fast synthesis total time: {total_time:.3f}s")
        
        return send_file(temp_path, mimetype='audio/wav', as_attachment=False)
        
    except Exception as e:
        print(f"Error in fast synthesis: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Fast synthesis failed: {str(e)}"}), 500

@app.route('/clone', methods=['POST'])
def clone_voice():
    """
    Voice cloning endpoint that accepts a reference audio file
    """
    global tts
    if tts is None:
        if not load_model():
            return jsonify({"error": "XTTS-v2 model not loaded"}), 500
    
    # Check if request has file part
    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400
    
    file = request.files['audio']
    if file.filename == '':
        return jsonify({"error": "No audio file selected"}), 400
    
    # Get other parameters
    text = request.form.get('text', '')
    language = request.form.get('language', 'ko')
    sample_rate = int(request.form.get('sample_rate', 24000))
    
    if not text:
        return jsonify({"error": "No text provided"}), 400
    
    try:
        # Save uploaded audio file temporarily
        speaker_temp_path = os.path.join('/tmp', f"speaker_ref_{uuid.uuid4().hex}.wav")
        file.save(speaker_temp_path)
        
        # Generate speech with voice cloning
        output_temp_path = os.path.join('/tmp', f"xtts_v2_cloned_{uuid.uuid4().hex}.wav")
        
        print(f"Cloning voice for text: '{text}' in language '{language}'")
        with suppress_stdout():
            tts.tts_to_file(
                text=text,
                file_path=output_temp_path,
                speaker_wav=speaker_temp_path,
                language=language
            )
        print(f"[DEBUG] Voice cloning synthesis completed with language='{language}'")
        
        # Convert to stereo and resample if needed
        mono_audio, original_sr = sf.read(output_temp_path)
        
        if sample_rate != original_sr:
            import librosa
            mono_audio = librosa.resample(mono_audio, orig_sr=original_sr, target_sr=sample_rate)
            sr = sample_rate
        else:
            sr = original_sr
        
        # Convert to stereo
        if len(mono_audio.shape) == 1:
            stereo_audio = np.column_stack((mono_audio, mono_audio))
        else:
            stereo_audio = mono_audio
        
        # Save final stereo file
        final_temp_path = os.path.join('/tmp', f"xtts_v2_final_{uuid.uuid4().hex}.wav")
        sf.write(final_temp_path, stereo_audio, sr)
        
        # Clean up temporary files
        if os.path.exists(speaker_temp_path):
            os.remove(speaker_temp_path)
        if os.path.exists(output_temp_path):
            os.remove(output_temp_path)
        
        print(f"Generated cloned voice audio: {final_temp_path}")
        return send_file(final_temp_path, mimetype='audio/wav', as_attachment=False)
        
    except Exception as e:
        print(f"Error in voice cloning: {e}")
        return jsonify({"error": f"Voice cloning failed: {str(e)}"}), 500

if __name__ == '__main__':
    # This will only run when testing directly with python xtts_v2_server.py
    # In production, use: uvicorn xtts_v2_server:asgi_app --host 0.0.0.0 --port 5006
    print("Starting XTTS-v2 server for testing (use Uvicorn for production)")
    app.run(port=5006, host='0.0.0.0')
