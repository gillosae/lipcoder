#!/usr/bin/env python3
"""
Test script for MMS-TTS Korean server
"""
import requests
import json
import time

def test_mms_tts_server():
    """Test the MMS-TTS server with Korean text"""
    
    # Server URL
    server_url = "http://localhost:5006"
    
    # Test health endpoint
    print("Testing health endpoint...")
    try:
        health_response = requests.get(f"{server_url}/health", timeout=10)
        if health_response.status_code == 200:
            health_data = health_response.json()
            print(f"✅ Health check passed: {health_data}")
        else:
            print(f"❌ Health check failed: {health_response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Health check error: {e}")
        return False
    
    # Test Korean TTS
    test_texts = [
        "안녕하세요",  # Hello
        "테스트",      # Test
        "한국어",      # Korean
        "프로그래밍",  # Programming
        "변수",        # Variable
        "함수",        # Function
    ]
    
    print("\nTesting TTS generation...")
    for i, text in enumerate(test_texts):
        print(f"Testing text {i+1}: '{text}'")
        
        try:
            # Make TTS request
            tts_data = {
                "text": text,
                "sample_rate": 24000
            }
            
            start_time = time.time()
            response = requests.post(
                f"{server_url}/tts", 
                json=tts_data,
                headers={"Content-Type": "application/json"},
                timeout=30
            )
            end_time = time.time()
            
            if response.status_code == 200:
                # Save the audio file
                filename = f"test_mms_tts_{i+1}_{text}.wav"
                with open(filename, 'wb') as f:
                    f.write(response.content)
                
                duration = end_time - start_time
                size = len(response.content)
                print(f"  ✅ Generated audio: {filename} ({size} bytes, {duration:.2f}s)")
            else:
                print(f"  ❌ TTS failed: {response.status_code} - {response.text}")
                
        except Exception as e:
            print(f"  ❌ TTS error: {e}")
    
    print("\n🎉 MMS-TTS test completed!")
    return True

if __name__ == "__main__":
    print("MMS-TTS Korean Server Test")
    print("=" * 40)
    test_mms_tts_server()
