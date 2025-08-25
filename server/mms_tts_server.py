from asgiref.wsgi import WsgiToAsgi
from flask import Flask, request, send_file
import torch
import uuid
import os
import numpy as np
import soundfile as sf
from transformers import VitsModel, AutoTokenizer
import scipy.io.wavfile
import tempfile
import subprocess
import re

app = Flask(__name__)

# Initialize persistent MMS-TTS model for Korean
device = 'cuda' if torch.cuda.is_available() else 'cpu'
print(f"Using device: {device}")

# Load the Facebook MMS-TTS Korean model
model_name = "facebook/mms-tts-kor"
print(f"Loading MMS-TTS model: {model_name}")

try:
    model = VitsModel.from_pretrained(model_name)
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = model.to(device)
    print(f"MMS-TTS Korean model loaded successfully on {device}")
except Exception as e:
    print(f"Error loading MMS-TTS model: {e}")
    model = None
    tokenizer = None

def romanize_korean(text):
    """
    Simple Korean romanization for MMS-TTS.
    MMS-TTS models expect romanized input, not native Korean script.
    This is a basic implementation - for production use, consider using uroman.
    """
    # Korean consonants and vowels mapping to romanization
    # This is a simplified mapping - MMS-TTS may need more sophisticated preprocessing
    
    # Basic Korean character mappings (Revised Romanization)
    korean_to_roman = {
        # Basic consonants
        'ㄱ': 'g', 'ㄴ': 'n', 'ㄷ': 'd', 'ㄹ': 'r', 'ㅁ': 'm', 
        'ㅂ': 'b', 'ㅅ': 's', 'ㅇ': '', 'ㅈ': 'j', 'ㅊ': 'ch', 
        'ㅋ': 'k', 'ㅌ': 't', 'ㅍ': 'p', 'ㅎ': 'h',
        
        # Double consonants
        'ㄲ': 'kk', 'ㄸ': 'tt', 'ㅃ': 'pp', 'ㅆ': 'ss', 'ㅉ': 'jj',
        
        # Basic vowels
        'ㅏ': 'a', 'ㅑ': 'ya', 'ㅓ': 'eo', 'ㅕ': 'yeo', 'ㅗ': 'o', 
        'ㅛ': 'yo', 'ㅜ': 'u', 'ㅠ': 'yu', 'ㅡ': 'eu', 'ㅣ': 'i',
        
        # Complex vowels
        'ㅐ': 'ae', 'ㅒ': 'yae', 'ㅔ': 'e', 'ㅖ': 'ye', 'ㅘ': 'wa', 
        'ㅙ': 'wae', 'ㅚ': 'oe', 'ㅝ': 'wo', 'ㅞ': 'we', 'ㅟ': 'wi', 'ㅢ': 'ui'
    }
    
    # For now, let's try a simple approach: if the text contains Korean characters,
    # we'll use a basic phonetic approximation
    if any('\u3131' <= char <= '\u3163' or '\uac00' <= char <= '\ud7a3' for char in text):
        # This is Korean text - for now, let's try some common Korean words
        # In a production system, you'd want proper uroman integration
        
        common_words = {
            '변수': 'byeonsu',
            '함수': 'hamsu', 
            '클래스': 'keullaeseu',
            '객체': 'gaekche',
            '배열': 'baeyeol',
            '문자열': 'munjayeol',
            '정수': 'jeongsu',
            '실수': 'silsu',
            '불린': 'bullin',
            '조건': 'jogeon',
            '반복': 'banbok',
            '메서드': 'meseodeu',
            '속성': 'sokseong',
            '상속': 'sangseok',
            '인터페이스': 'inteopeiseu',
            '모듈': 'modyul',
            '패키지': 'paekiji',
            '라이브러리': 'raibeureori',
            '프레임워크': 'peureimuweokeu',
            '데이터베이스': 'deitabeisjeu',
            '서버': 'seobeoj',
            '클라이언트': 'keullaienteu',
            '네트워크': 'neteuwokeu',
            '보안': 'boan',
            '암호화': 'amhohwa',
            '인증': 'injeung',
            '권한': 'gwonhan',
            '사용자': 'sayongja',
            '관리자': 'gwanlija',
            '설정': 'seoljeong',
            '구성': 'guseong',
            '환경': 'hwangyeong',
            '개발': 'gaebal',
            '테스트': 'teseuteu',
            '배포': 'baepo',
            '버전': 'beojeun',
            '업데이트': 'eobdeiteu',
            '버그': 'beogeu',
            '오류': 'oryu',
            '예외': 'yeooe',
            '디버그': 'dibeogu',
            '로그': 'rogeu',
            '모니터링': 'moniteoling',
            '성능': 'seongneung',
            '최적화': 'choejeokwa',
            '알고리즘': 'algoriteum',
            '자료구조': 'jaryogujo',
            '스택': 'seutaek',
            '큐': 'kyu',
            '리스트': 'riseuteu',
            '딕셔너리': 'diksyeoneori',
            '해시': 'haesi',
            '트리': 'teuri',
            '그래프': 'geuraepeu',
            '정렬': 'jeongryeol',
            '검색': 'geomsaek',
            '파일': 'pail',
            '폴더': 'poldeo',
            '디렉토리': 'direktori',
            '경로': 'gyeongro',
            '확장자': 'hwakjangja',
            '압축': 'apchuk',
            '백업': 'baegeop',
            '복원': 'bogwon',
            '동기화': 'donggihwa',
            '비동기': 'bidongi',
            '스레드': 'seuledeu',
            '프로세스': 'peuroseseu',
            '메모리': 'memori',
            'CPU': 'sipiyu',
            'GPU': 'jipiyu',
            '하드웨어': 'hadeuweeoj',
            '소프트웨어': 'sopeuteuweeoj',
            '운영체제': 'unyeongcheje',
            '윈도우': 'windou',
            '리눅스': 'rinukseu',
            '맥': 'maek',
            '안드로이드': 'andeuroideu',
            'iOS': 'aioseuseu',
            '웹': 'web',
            '브라우저': 'beuraujo',
            'HTML': 'eichtiemeel',
            'CSS': 'sieseu',
            'JavaScript': 'jabaseukeuripteu',
            'Python': 'paisseon',
            'Java': 'jaba',
            'C++': 'si peulleoseu peulleoseu',
            'C#': 'si syapeu',
            'PHP': 'pieichipi',
            'Ruby': 'rubi',
            'Go': 'go',
            'Rust': 'reoseteu',
            'Swift': 'seuwiteu',
            'Kotlin': 'koteulin',
            'TypeScript': 'taipeuseukeulipteu',
            'React': 'riaegteu',
            'Vue': 'byu',
            'Angular': 'aenggyulleo',
            'Node.js': 'nodeujieseu',
            'Express': 'ikseupeureseu',
            'Django': 'janggo',
            'Flask': 'peullaesukeu',
            'Spring': 'seupeuring',
            'Laravel': 'rarabel',
            'Rails': 'reilseu',
            'MySQL': 'maieskuel',
            'PostgreSQL': 'poseuteugeurieskuel',
            'MongoDB': 'monggodibi',
            'Redis': 'rediseu',
            'Docker': 'dokeo',
            'Kubernetes': 'kubernetiseu',
            'AWS': 'eibeullyueseu',
            'Azure': 'aejyueo',
            'GCP': 'jisipi',
            'Git': 'giteu',
            'GitHub': 'giteuheobeu',
            'GitLab': 'giteullaebeu',
            'Jenkins': 'jenkinseu',
            'CI/CD': 'siaisildi',
            'API': 'eipiaiyi',
            'REST': 'reseut',
            'GraphQL': 'geuraepeukyuel',
            'JSON': 'jeiseon',
            'XML': 'ekseuemeel',
            'YAML': 'yamel',
            'Markdown': 'makeudasun',
            'LaTeX': 'ratek',
            'PDF': 'pidiepeu',
            'CSV': 'sibeui',
            'Excel': 'eksel',
            'PowerPoint': 'paweopotinteu',
            'Word': 'wodeu',
            'Outlook': 'autluk',
            'Teams': 'timseu',
            'Slack': 'seullaek',
            'Discord': 'diseukoedeu',
            'Zoom': 'jum',
            'Skype': 'seukaipeu',
            'Chrome': 'keurom',
            'Firefox': 'paieopogseu',
            'Safari': 'sapari',
            'Edge': 'ejeu',
            'Internet Explorer': 'inteonet ikseupeulloreo',
            'Opera': 'opera',
            'Photoshop': 'potosyop',
            'Illustrator': 'ilreoseuteureiteo',
            'InDesign': 'indijain',
            'Premiere': 'peurimieoj',
            'After Effects': 'apteo ipekteu',
            'Final Cut': 'painol keot',
            'Logic Pro': 'rojik peuro',
            'GarageBand': 'garejibaendeu',
            'Xcode': 'ekseukoedeu',
            'Visual Studio': 'bijueol seutyudio',
            'IntelliJ': 'intelrijei',
            'Eclipse': 'iklipseu',
            'Atom': 'atom',
            'Sublime Text': 'seobeullaim tekseuteu',
            'Notepad++': 'noteupaedeu peulleoseu peulleoseu',
            'Vim': 'bim',
            'Emacs': 'imaekseu',
            'Nano': 'nano'
        }
        
        # Try to find exact match first
        if text.strip() in common_words:
            romanized = common_words[text.strip()]
            print(f"Romanized '{text}' -> '{romanized}'")
            return romanized
        
        # If no exact match, try basic character-by-character conversion
        # This is very basic and may not work well for complex Korean text
        result = ""
        for char in text:
            if char in korean_to_roman:
                result += korean_to_roman[char]
            elif '\uac00' <= char <= '\ud7a3':  # Korean syllables
                # This is a Korean syllable - for now, just use a placeholder
                # In production, you'd decompose the syllable and romanize properly
                result += "han"  # Generic placeholder
            else:
                result += char  # Keep non-Korean characters as-is
        
        if result != text:
            print(f"Basic romanization '{text}' -> '{result}'")
            return result
    
    # If not Korean or no conversion needed, return as-is
    return text

# Expose ASGI application for Uvicorn
asgi_app = WsgiToAsgi(app)

@app.route('/tts', methods=['POST'])
def tts():
    if model is None or tokenizer is None:
        return {"error": "MMS-TTS model not loaded"}, 500
    
    data = request.json
    text = data['text']
    sample_rate = data.get('sample_rate', 16000)  # MMS-TTS default is 16kHz
    
    print(f"Generating TTS for text: '{text}' at {sample_rate}Hz")
    
    # Romanize Korean text for MMS-TTS model
    romanized_text = romanize_korean(text)
    if romanized_text != text:
        print(f"Using romanized text: '{romanized_text}'")
    
    try:
        # Tokenize the romanized input text
        inputs = tokenizer(romanized_text, return_tensors="pt")
        
        # Fix tensor types - ensure input_ids are Long tensors
        if 'input_ids' in inputs:
            inputs['input_ids'] = inputs['input_ids'].long()
        if 'attention_mask' in inputs:
            inputs['attention_mask'] = inputs['attention_mask'].long()
            
        # Move to device
        inputs = {k: v.to(device) for k, v in inputs.items()}
        
        print(f"Input tensor types: {[(k, v.dtype) for k, v in inputs.items()]}")
        
        # Generate audio with the model
        with torch.no_grad():
            output = model(**inputs).waveform
        
        # Convert to numpy array and ensure it's on CPU
        audio_array = output.squeeze().cpu().numpy()
        
        # Ensure the audio is in the correct format
        if audio_array.dtype != np.float32:
            audio_array = audio_array.astype(np.float32)
        
        # Normalize audio to prevent clipping
        if np.max(np.abs(audio_array)) > 0:
            audio_array = audio_array / np.max(np.abs(audio_array)) * 0.95
        
        # Generate temporary mono file
        mono_temp_path = os.path.join('/tmp', f"mms_tts_mono_{uuid.uuid4().hex}.wav")
        
        # Save as WAV file using scipy (MMS-TTS outputs at 16kHz by default)
        model_sample_rate = model.config.sampling_rate
        scipy.io.wavfile.write(mono_temp_path, model_sample_rate, (audio_array * 32767).astype(np.int16))
        
        # Convert mono to stereo if needed
        stereo_temp_path = os.path.join('/tmp', f"mms_tts_stereo_{uuid.uuid4().hex}.wav")
        
        # Read the mono audio
        mono_audio, sr = sf.read(mono_temp_path)
        
        # Resample if requested sample rate is different from model's output
        if sample_rate != model_sample_rate:
            import librosa
            mono_audio = librosa.resample(mono_audio, orig_sr=model_sample_rate, target_sr=sample_rate)
            sr = sample_rate
        
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
        return send_file(stereo_temp_path, mimetype='audio/wav')
        
    except Exception as e:
        print(f"Error generating TTS: {e}")
        return {"error": f"TTS generation failed: {str(e)}"}, 500

@app.route('/health', methods=['GET'])
def health():
    return {
        "status": "healthy",
        "model_loaded": model is not None,
        "device": device,
        "model_name": model_name
    }

if __name__ == '__main__':
    app.run(port=5006, host='0.0.0.0')
