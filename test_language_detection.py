#!/usr/bin/env python3
"""
Test script to verify XTTS language detection is working correctly
"""

import requests
import json

# Test cases with different languages
test_cases = [
    {"text": "hello world", "expected_lang": "en", "description": "English text"},
    {"text": "안녕하세요", "expected_lang": "ko", "description": "Korean text"},
    {"text": "function", "expected_lang": "en", "description": "English programming term"},
    {"text": "변수", "expected_lang": "ko", "description": "Korean programming term"},
    {"text": "print", "expected_lang": "en", "description": "English keyword"},
    {"text": "123", "expected_lang": "en", "description": "Numbers (should default to English)"},
    {"text": "def", "expected_lang": "en", "description": "Programming keyword"},
]

def test_xtts_language_detection():
    """Test XTTS language detection"""
    server_url = "http://localhost:5006"
    
    # First check if server is running
    try:
        health_response = requests.get(f"{server_url}/health")
        if health_response.status_code != 200:
            print("❌ XTTS server is not running or not healthy")
            return
        print("✅ XTTS server is running")
    except requests.exceptions.ConnectionError:
        print("❌ Cannot connect to XTTS server at http://localhost:5006")
        print("   Make sure to start the server with: cd server && python xtts_v2_server.py")
        return
    
    print("\n🧪 Testing XTTS Language Detection...")
    print("=" * 60)
    
    for i, test_case in enumerate(test_cases, 1):
        text = test_case["text"]
        expected_lang = test_case["expected_lang"]
        description = test_case["description"]
        
        print(f"\n{i}. Testing: {description}")
        print(f"   Text: '{text}'")
        print(f"   Expected language: {expected_lang}")
        
        # Test with fast endpoint (our optimized version)
        try:
            response = requests.post(f"{server_url}/tts_fast", 
                json={
                    "text": text,
                    "language": "auto",  # Let server auto-detect
                    "sample_rate": 24000,
                    "category": "test"
                },
                timeout=10
            )
            
            if response.status_code == 200:
                print(f"   ✅ Fast endpoint: SUCCESS")
            else:
                print(f"   ❌ Fast endpoint: ERROR {response.status_code}")
                try:
                    error_data = response.json()
                    print(f"      Error: {error_data.get('error', 'Unknown error')}")
                except:
                    print(f"      Raw response: {response.text[:200]}")
                    
        except requests.exceptions.Timeout:
            print(f"   ⏱️  Fast endpoint: TIMEOUT (>10s)")
        except Exception as e:
            print(f"   ❌ Fast endpoint: EXCEPTION - {e}")
        
        # Also test with regular endpoint for comparison
        try:
            response = requests.post(f"{server_url}/tts", 
                json={
                    "text": text,
                    "language": "auto",  # Let server auto-detect
                    "sample_rate": 24000,
                    "category": "test"
                },
                timeout=10
            )
            
            if response.status_code == 200:
                print(f"   ✅ Regular endpoint: SUCCESS")
            else:
                print(f"   ❌ Regular endpoint: ERROR {response.status_code}")
                
        except requests.exceptions.Timeout:
            print(f"   ⏱️  Regular endpoint: TIMEOUT (>10s)")
        except Exception as e:
            print(f"   ❌ Regular endpoint: EXCEPTION - {e}")
    
    print("\n" + "=" * 60)
    print("🔍 Check the server logs to see the language detection details!")
    print("   Look for lines containing '[DEBUG] Language detection details'")
    print("\n💡 If you're hearing the wrong language:")
    print("   1. Check the server logs for language detection details")
    print("   2. Verify the client is sending the correct language parameter")
    print("   3. Make sure XTTS model supports the detected language")

if __name__ == "__main__":
    test_xtts_language_detection()
