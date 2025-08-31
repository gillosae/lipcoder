from flask import Flask, request, jsonify, Response
import subprocess
import uuid
import os
import tempfile
import shutil
import logging
import platform

app = Flask(__name__)

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Check if we're on macOS and if 'say' command is available
def check_macos_say_available():
    if platform.system() != 'Darwin':
        return False
    try:
        # Test say command with a simple usage check (no --version option available)
        result = subprocess.run(['say', '-v', '?'], 
                              capture_output=True, text=True, timeout=5)
        return result.returncode == 0 and len(result.stdout.strip()) > 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False

# Global check on startup
MACOS_SAY_AVAILABLE = check_macos_say_available()
if not MACOS_SAY_AVAILABLE:
    if platform.system() != 'Darwin':
        logger.error("macOS TTS server can only run on macOS")
    else:
        logger.error("macOS 'say' command is not available")
else:
    logger.info("macOS 'say' command is available and ready")

# Get list of available voices
def get_available_voices():
    """Get list of available macOS voices"""
    if not MACOS_SAY_AVAILABLE:
        return []
    
    try:
        result = subprocess.run(['say', '-v', '?'], 
                              capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            voices = []
            for line in result.stdout.strip().split('\n'):
                if line.strip():
                    # Parse voice line format: "VoiceName    language    # description"
                    parts = line.strip().split()
                    if parts:
                        voice_name = parts[0]
                        voices.append(voice_name)
            return voices
        else:
            logger.error(f"Failed to get voices: {result.stderr}")
            return []
    except Exception as e:
        logger.error(f"Error getting voices: {str(e)}")
        return []

# Cache available voices on startup
AVAILABLE_VOICES = get_available_voices()
logger.info(f"Found {len(AVAILABLE_VOICES)} macOS voices: {AVAILABLE_VOICES[:5]}{'...' if len(AVAILABLE_VOICES) > 5 else ''}")

@app.route('/tts', methods=['POST'])
def tts():
    if not MACOS_SAY_AVAILABLE:
        return jsonify({'error': 'macOS say command is not available'}), 500
        
    try:
        data = request.json
        text = data['text']
        
        # Extract macOS say parameters from request
        voice = data.get('voice', 'Albert')  # Default to Albert voice (available on macOS)
        rate = data.get('rate', 200)       # words per minute (default: 200)
        volume = data.get('volume', 0.7)   # volume 0.0-1.0 (default: 0.7)
        sample_rate = data.get('sample_rate', 24000)  # output sample rate
        
        # DEBUG: Log the exact voice being requested
        logger.info(f"🔍 DEBUG TTS request: text='{text}', voice='{voice}', rate={rate}, volume={volume}")
        logger.info(f"🔍 DEBUG Voice type: {type(voice)}, Voice repr: {repr(voice)}")
        
        # Validate voice name
        if voice not in AVAILABLE_VOICES:
            logger.warning(f"Voice '{voice}' not found, using default 'Albert'")
            voice = 'Albert'
        
        # Create temporary file for output
        with tempfile.NamedTemporaryFile(suffix='.aiff', delete=False) as temp_file:
            temp_aiff_path = temp_file.name
        
        # Create temporary WAV file path
        temp_wav_path = temp_aiff_path.replace('.aiff', '.wav')
        
        try:
            # Build macOS say command
            # Note: macOS say doesn't support volume control via command line
            # Volume will be controlled by system volume settings
            cmd = [
                'say',
                '-v', voice,           # voice
                '-r', str(rate),       # rate (words per minute)
                '-o', temp_aiff_path,  # output to AIFF file
                text                   # text to synthesize
            ]
            
            # DEBUG: Log the exact command being run
            logger.info(f"🔍 DEBUG say command: {' '.join(cmd)}")
            
            # Run macOS say command
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            
            if result.returncode != 0:
                logger.error(f"🔍 DEBUG say stderr: {result.stderr}")
                logger.error(f"🔍 DEBUG say stdout: {result.stdout}")
                logger.error(f"macOS say failed: {result.stderr}")
                return jsonify({
                    'error': 'macOS say synthesis failed',
                    'details': result.stderr
                }), 500
            
            # Check if output file was created
            if not os.path.exists(temp_aiff_path):
                return jsonify({'error': 'No audio output generated'}), 500
            
            # Convert AIFF to WAV using ffmpeg (if available) or afconvert
            try:
                # Try ffmpeg first (better quality and more options)
                ffmpeg_cmd = [
                    'ffmpeg', '-y',  # -y to overwrite output file
                    '-i', temp_aiff_path,
                    '-ar', str(sample_rate),  # set sample rate
                    '-ac', '2',  # stereo output
                    '-f', 'wav',  # WAV format
                    temp_wav_path
                ]
                
                ffmpeg_result = subprocess.run(ffmpeg_cmd, capture_output=True, text=True, timeout=10)
                
                if ffmpeg_result.returncode != 0:
                    # Fallback to afconvert (built into macOS)
                    logger.info("ffmpeg failed, falling back to afconvert")
                    afconvert_cmd = [
                        'afconvert',
                        '-f', 'WAVE',  # WAV format
                        '-d', 'LEI16@' + str(sample_rate),  # 16-bit little-endian at specified sample rate
                        temp_aiff_path,
                        temp_wav_path
                    ]
                    
                    afconvert_result = subprocess.run(afconvert_cmd, capture_output=True, text=True, timeout=10)
                    
                    if afconvert_result.returncode != 0:
                        logger.error(f"Both ffmpeg and afconvert failed: {afconvert_result.stderr}")
                        return jsonify({'error': 'Audio conversion failed'}), 500
                        
            except subprocess.TimeoutExpired:
                return jsonify({'error': 'Audio conversion timeout'}), 500
            
            # Check if WAV file was created
            if not os.path.exists(temp_wav_path):
                return jsonify({'error': 'WAV conversion failed'}), 500
            
            # Read the WAV file
            with open(temp_wav_path, 'rb') as f:
                audio_data = f.read()
            
            # Clean up temporary files
            try:
                os.unlink(temp_aiff_path)
                os.unlink(temp_wav_path)
            except OSError:
                pass  # Ignore cleanup errors
            
            logger.info(f"Successfully generated {len(audio_data)} bytes of audio")
            
            # Return audio data as binary response
            return Response(audio_data, mimetype='audio/wav')
            
        except subprocess.TimeoutExpired:
            # Clean up on timeout
            try:
                os.unlink(temp_aiff_path)
                if os.path.exists(temp_wav_path):
                    os.unlink(temp_wav_path)
            except OSError:
                pass
            return jsonify({'error': 'macOS say timeout'}), 500
            
        except Exception as e:
            # Clean up on any other error
            try:
                os.unlink(temp_aiff_path)
                if os.path.exists(temp_wav_path):
                    os.unlink(temp_wav_path)
            except OSError:
                pass
            logger.error(f"Unexpected error: {str(e)}")
            return jsonify({'error': f'Unexpected error: {str(e)}'}), 500
            
    except Exception as e:
        logger.error(f"Request processing error: {str(e)}")
        return jsonify({'error': f'Request processing error: {str(e)}'}), 500

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'macos_say_available': MACOS_SAY_AVAILABLE,
        'platform': platform.system(),
        'service': 'macOS Native TTS Server',
        'voices_count': len(AVAILABLE_VOICES)
    })

@app.route('/voices', methods=['GET'])
def list_voices():
    """List available macOS voices"""
    if not MACOS_SAY_AVAILABLE:
        return jsonify({'error': 'macOS say command is not available'}), 500
    
    try:
        # Get detailed voice information
        result = subprocess.run(['say', '-v', '?'], 
                              capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            voices_detailed = []
            voices_simple = []
            
            for line in result.stdout.strip().split('\n'):
                if line.strip():
                    # Parse voice line format: "VoiceName    language    # description"
                    parts = line.strip().split('#', 1)
                    if len(parts) >= 1:
                        voice_info = parts[0].strip().split()
                        if voice_info:
                            voice_name = voice_info[0]
                            language = voice_info[1] if len(voice_info) > 1 else 'unknown'
                            description = parts[1].strip() if len(parts) > 1 else ''
                            
                            voices_simple.append(voice_name)
                            voices_detailed.append({
                                'name': voice_name,
                                'language': language,
                                'description': description
                            })
            
            return jsonify({
                'voices': voices_simple,
                'voices_detailed': voices_detailed,
                'count': len(voices_simple),
                'raw_output': result.stdout.split('\n')
            })
        else:
            return jsonify({'error': 'Failed to list voices'}), 500
    except Exception as e:
        return jsonify({'error': f'Error listing voices: {str(e)}'}), 500

@app.route('/test', methods=['GET'])
def test_voice():
    """Test endpoint to verify macOS TTS is working"""
    if not MACOS_SAY_AVAILABLE:
        return jsonify({'error': 'macOS say command is not available'}), 500
    
    try:
        # Test with a simple phrase
        test_text = "Hello, this is a test of macOS native voice synthesis."
        
        # Use default voice for testing
        cmd = ['say', test_text]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        
        if result.returncode == 0:
            return jsonify({
                'status': 'success',
                'message': 'macOS TTS test completed successfully',
                'test_text': test_text
            })
        else:
            return jsonify({
                'status': 'error',
                'message': 'macOS TTS test failed',
                'error': result.stderr
            }), 500
            
    except Exception as e:
        return jsonify({'error': f'Test error: {str(e)}'}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5008))  # Use port 5008 for macOS TTS
    logger.info(f"Starting macOS native TTS server on port {port}")
    if MACOS_SAY_AVAILABLE:
        logger.info(f"Available voices: {len(AVAILABLE_VOICES)} voices found")
    app.run(host='0.0.0.0', port=port, debug=False)
