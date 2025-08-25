#!/usr/bin/env python3
"""
Debug XTTS synthesis to find why it's producing gibberish
"""

import requests
import json
import time

def test_xtts_synthesis():
    """Test XTTS synthesis with detailed logging"""
    
    server_url = "http://localhost:5006"
    
    print("🔍 Debugging XTTS Synthesis")
    print("=" * 50)
    
    # Check server health first
    try:
        health = requests.get(f"{server_url}/health", timeout=5)
        if health.status_code == 200:
            health_data = health.json()
            print("✅ Server is running")
            print(f"   Model loaded: {health_data.get('model_loaded')}")
            print(f"   Direct model loaded: {health_data.get('direct_model_loaded')}")
            print(f"   Device: {health_data.get('device')}")
            print(f"   Supported languages: {health_data.get('supported_languages', [])}")
        else:
            print("❌ Server health check failed")
            return
    except Exception as e:
        print(f"❌ Cannot connect to server: {e}")
        return
    
    # Test cases with different complexity
    test_cases = [
        {
            "text": "hello",
            "language": "en", 
            "category": "variable",
            "description": "Simple English word"
        },
        {
            "text": "function",
            "language": "en",
            "category": "keyword", 
            "description": "Programming keyword"
        },
        {
            "text": "안녕",
            "language": "ko",
            "category": "variable",
            "description": "Simple Korean word"
        }
    ]
    
    print(f"\n🧪 Testing {len(test_cases)} synthesis cases...")
    print("Watch the server console for detailed logs!")
    print("-" * 50)
    
    for i, test in enumerate(test_cases, 1):
        print(f"\n{i}. Testing: '{test['text']}' ({test['description']})")
        print(f"   Language: {test['language']}, Category: {test['category']}")
        
        # Test with fast endpoint first
        try:
            start_time = time.time()
            
            response = requests.post(f"{server_url}/tts_fast", 
                json={
                    "text": test['text'],
                    "language": test['language'],
                    "category": test['category'],
                    "sample_rate": 24000
                },
                timeout=30
            )
            
            elapsed = time.time() - start_time
            
            if response.status_code == 200:
                audio_size = len(response.content)
                print(f"   ✅ Fast endpoint: SUCCESS ({audio_size} bytes, {elapsed:.2f}s)")
                
                # Save audio for manual inspection
                filename = f"debug_{test['language']}_{test['category']}_{test['text']}.wav"
                with open(filename, 'wb') as f:
                    f.write(response.content)
                print(f"   💾 Saved audio: {filename}")
                
            else:
                print(f"   ❌ Fast endpoint: FAILED ({response.status_code})")
                try:
                    error_data = response.json()
                    print(f"      Error: {error_data.get('error', 'Unknown')}")
                except:
                    print(f"      Raw response: {response.text[:200]}")
        
        except Exception as e:
            print(f"   ❌ Fast endpoint: EXCEPTION - {e}")
        
        # Also test regular endpoint for comparison
        try:
            start_time = time.time()
            
            response = requests.post(f"{server_url}/tts", 
                json={
                    "text": test['text'],
                    "language": test['language'],
                    "category": test['category'],
                    "sample_rate": 24000
                },
                timeout=30
            )
            
            elapsed = time.time() - start_time
            
            if response.status_code == 200:
                audio_size = len(response.content)
                print(f"   ✅ Regular endpoint: SUCCESS ({audio_size} bytes, {elapsed:.2f}s)")
            else:
                print(f"   ❌ Regular endpoint: FAILED ({response.status_code})")
        
        except Exception as e:
            print(f"   ❌ Regular endpoint: EXCEPTION - {e}")
    
    print("\n" + "=" * 50)
    print("🔍 Check the XTTS server console for detailed debug logs!")
    print("Look for these log patterns:")
    print("  - '[DEBUG] Language detection details'")
    print("  - '[DEBUG] TTS synthesis completed'") 
    print("  - '[DEBUG] Fast synthesis used language'")
    print("  - Any error messages or warnings")
    print("\n💡 If audio files sound like gibberish:")
    print("  1. Check if the XTTS model loaded correctly")
    print("  2. Verify the language parameter is being used")
    print("  3. Check speaker embedding extraction")
    print("  4. Try different synthesis parameters")

if __name__ == "__main__":
    test_xtts_synthesis()
