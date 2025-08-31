#!/usr/bin/env python3
"""
Simple test to check if Hugging Face Whisper can be loaded
"""

import sys
import traceback

def test_imports():
    """Test basic imports"""
    try:
        print("🔍 Testing basic imports...")
        
        import torch
        print(f"✅ PyTorch: {torch.__version__}")
        
        import transformers
        print(f"✅ Transformers: {transformers.__version__}")
        
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
        print("✅ Whisper classes imported")
        
        import flask
        print(f"✅ Flask: {flask.__version__}")
        
        return True
        
    except Exception as e:
        print(f"❌ Import error: {e}")
        traceback.print_exc()
        return False

def test_whisper_model():
    """Test Whisper model loading"""
    try:
        print("\n🤖 Testing Whisper model loading...")
        
        # Use smaller model for testing
        model_id = "openai/whisper-tiny"
        print(f"📥 Loading model: {model_id}")
        
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
        import torch
        
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        torch_dtype = torch.float16 if torch.cuda.is_available() else torch.float32
        
        print(f"🔧 Device: {device}, dtype: {torch_dtype}")
        
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            model_id, 
            torch_dtype=torch_dtype, 
            low_cpu_mem_usage=True, 
            use_safetensors=True
        )
        model.to(device)
        
        processor = AutoProcessor.from_pretrained(model_id)
        
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
        
        print("✅ Whisper model loaded successfully!")
        return True
        
    except Exception as e:
        print(f"❌ Model loading error: {e}")
        traceback.print_exc()
        return False

def test_flask_server():
    """Test simple Flask server"""
    try:
        print("\n🌐 Testing Flask server...")
        
        from flask import Flask, jsonify
        
        app = Flask(__name__)
        
        @app.route('/health')
        def health():
            return jsonify({'status': 'ok'})
        
        print("✅ Flask server setup successful!")
        return True
        
    except Exception as e:
        print(f"❌ Flask server error: {e}")
        traceback.print_exc()
        return False

if __name__ == '__main__':
    print("🧪 Hugging Face Whisper Test Suite")
    print("=" * 50)
    
    success = True
    
    # Test imports
    if not test_imports():
        success = False
    
    # Test Whisper model (only if imports work)
    if success:
        if not test_whisper_model():
            success = False
    
    # Test Flask server
    if success:
        if not test_flask_server():
            success = False
    
    print("\n" + "=" * 50)
    if success:
        print("🎉 All tests passed! Hugging Face Whisper is ready.")
    else:
        print("❌ Some tests failed. Check the errors above.")
    
    sys.exit(0 if success else 1)
