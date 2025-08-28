from flask import Flask, request, jsonify
import subprocess
import uuid
import os
import tempfile
import shutil
import logging

app = Flask(__name__)

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Check if espeak-ng is available
def check_espeak_available():
    try:
        result = subprocess.run(['espeak-ng', '--version'], 
                              capture_output=True, text=True, timeout=5)
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False

# Global check on startup
ESPEAK_AVAILABLE = check_espeak_available()
if not ESPEAK_AVAILABLE:
    logger.error("espeak-ng is not available. Please install it with: brew install espeak-ng")
else:
    logger.info("espeak-ng is available and ready")

# Flask app for direct use

@app.route('/tts', methods=['POST'])
def tts():
    if not ESPEAK_AVAILABLE:
        return jsonify({'error': 'espeak-ng is not installed'}), 500
        
    try:
        data = request.json
        text = data['text']
        
        # Extract espeak parameters from request
        voice = data.get('voice', 'en')
        speed = data.get('speed', 175)  # words per minute
        pitch = data.get('pitch', 50)   # 0-99
        amplitude = data.get('amplitude', 100)  # 0-200
        gap = data.get('gap', 0)        # gap between words in 10ms units
        sample_rate = data.get('sample_rate', 24000)
        
        # DEBUG: Log the exact voice being requested
        logger.info(f"🔍 DEBUG TTS request: text='{text}', voice='{voice}', speed={speed}, pitch={pitch}")
        logger.info(f"🔍 DEBUG Voice type: {type(voice)}, Voice repr: {repr(voice)}")
        
        # Create temporary file for output
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as temp_file:
            temp_path = temp_file.name
        
        try:
            # Build espeak-ng command
            cmd = [
                'espeak-ng',
                '-v', voice,           # voice
                '-s', str(speed),      # speed (words per minute)
                '-p', str(pitch),      # pitch (0-99)
                '-a', str(amplitude),  # amplitude (0-200)
                '-g', str(gap),        # gap between words
                '-w', temp_path,       # output to WAV file
                text                   # text to synthesize
            ]
            
            # DEBUG: Log the exact command being run
            logger.info(f"🔍 DEBUG espeak command: {' '.join(cmd)}")
            
            # Run espeak-ng
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            
            if result.returncode != 0:
                logger.error(f"🔍 DEBUG espeak-ng stderr: {result.stderr}")
                logger.error(f"🔍 DEBUG espeak-ng stdout: {result.stdout}")
                logger.error(f"espeak-ng failed: {result.stderr}")
                return jsonify({
                    'error': 'espeak-ng synthesis failed',
                    'details': result.stderr
                }), 500
            
            # Check if output file was created
            if not os.path.exists(temp_path):
                return jsonify({'error': 'No audio output generated'}), 500
            
            # Read the WAV file
            with open(temp_path, 'rb') as f:
                audio_data = f.read()
            
            # Clean up temporary file
            try:
                os.unlink(temp_path)
            except OSError:
                pass  # Ignore cleanup errors
            
            logger.info(f"Successfully generated {len(audio_data)} bytes of audio")
            
            # Return audio data as binary response
            from flask import Response
            return Response(audio_data, mimetype='audio/wav')
            
        except subprocess.TimeoutExpired:
            # Clean up on timeout
            try:
                os.unlink(temp_path)
            except OSError:
                pass
            return jsonify({'error': 'espeak-ng timeout'}), 500
            
        except Exception as e:
            # Clean up on any other error
            try:
                os.unlink(temp_path)
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
        'espeak_available': ESPEAK_AVAILABLE,
        'service': 'espeak-ng TTS Server'
    })

@app.route('/voices', methods=['GET'])
def list_voices():
    """List available espeak-ng voices"""
    if not ESPEAK_AVAILABLE:
        return jsonify({'error': 'espeak-ng is not installed'}), 500
    
    try:
        result = subprocess.run(['espeak-ng', '--voices'], 
                              capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            return jsonify({
                'voices': result.stdout,
                'raw_output': result.stdout.split('\n')
            })
        else:
            return jsonify({'error': 'Failed to list voices'}), 500
    except Exception as e:
        return jsonify({'error': f'Error listing voices: {str(e)}'}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5005))
    logger.info(f"Starting espeak-ng TTS server on port {port}")
    app.run(host='0.0.0.0', port=port, debug=False) 