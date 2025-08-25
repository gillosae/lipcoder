#!/usr/bin/env python3
"""
Test script for XTTS-v2 precomputed speaker embeddings
Tests both Korean and English voice synthesis with different categories
"""

import requests
import json
import time
import os
from pathlib import Path

# Server configuration
SERVER_URL = "http://localhost:5006"
OUTPUT_DIR = Path("test_outputs")
OUTPUT_DIR.mkdir(exist_ok=True)

def test_health():
    """Test server health and check preloaded embeddings"""
    print("🔍 Testing server health...")
    try:
        response = requests.get(f"{SERVER_URL}/health")
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Server is healthy")
            print(f"   Model loaded: {data.get('model_loaded', False)}")
            print(f"   Direct model loaded: {data.get('direct_model_loaded', False)}")
            print(f"   Device: {data.get('device', 'unknown')}")
            
            cache_stats = data.get('speaker_cache', {})
            print(f"   Cached embeddings: {cache_stats.get('cached_embeddings', 0)}")
            print(f"   Total extraction time: {cache_stats.get('total_extraction_time', 0):.3f}s")
            return True
        else:
            print(f"❌ Server health check failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Server health check error: {e}")
        return False

def test_cache_stats():
    """Get detailed cache statistics"""
    print("\n📊 Getting cache statistics...")
    try:
        response = requests.get(f"{SERVER_URL}/cache/stats")
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Cache statistics:")
            print(f"   Total cached embeddings: {data.get('cached_embeddings', 0)}")
            print(f"   Metadata entries: {data.get('metadata_entries', 0)}")
            
            voice_stats = data.get('voice_stats', {})
            for category, stats in voice_stats.items():
                print(f"   {category}: {stats['count']} files, {stats['total_extraction_time']:.3f}s")
            return True
        else:
            print(f"❌ Cache stats failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Cache stats error: {e}")
        return False

def test_synthesis(text, language, category, endpoint="tts_fast"):
    """Test TTS synthesis with specific parameters"""
    print(f"\n🎤 Testing {endpoint} synthesis:")
    print(f"   Text: '{text}'")
    print(f"   Language: {language}")
    print(f"   Category: {category}")
    
    try:
        start_time = time.time()
        
        payload = {
            "text": text,
            "language": language,
            "category": category,
            "sample_rate": 24000
        }
        
        response = requests.post(f"{SERVER_URL}/{endpoint}", json=payload)
        
        if response.status_code == 200:
            synthesis_time = time.time() - start_time
            
            # Save audio file
            filename = f"{category}_{language}_{endpoint}_{int(time.time())}.wav"
            output_path = OUTPUT_DIR / filename
            
            with open(output_path, 'wb') as f:
                f.write(response.content)
            
            print(f"✅ Synthesis successful in {synthesis_time:.3f}s")
            print(f"   Output: {output_path}")
            print(f"   File size: {len(response.content)} bytes")
            return True
        else:
            print(f"❌ Synthesis failed: {response.status_code}")
            try:
                error_data = response.json()
                print(f"   Error: {error_data.get('error', 'Unknown error')}")
            except:
                print(f"   Response: {response.text[:200]}")
            return False
    except Exception as e:
        print(f"❌ Synthesis error: {e}")
        return False

def test_preload_cache():
    """Test manual cache preloading"""
    print("\n🔄 Testing manual cache preload...")
    try:
        start_time = time.time()
        response = requests.post(f"{SERVER_URL}/cache/preload")
        
        if response.status_code == 200:
            preload_time = time.time() - start_time
            data = response.json()
            print(f"✅ Cache preload successful in {preload_time:.3f}s")
            print(f"   Server preload time: {data.get('preload_time', 0):.3f}s")
            
            cache_stats = data.get('cache_stats', {})
            print(f"   Cached embeddings: {cache_stats.get('cached_embeddings', 0)}")
            return True
        else:
            print(f"❌ Cache preload failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Cache preload error: {e}")
        return False

def main():
    """Run all tests"""
    print("🚀 Starting XTTS-v2 Precomputed Embeddings Test")
    print("=" * 60)
    
    # Test server health
    if not test_health():
        print("❌ Server is not healthy, exiting")
        return
    
    # Test cache statistics
    test_cache_stats()
    
    # Test manual preload (optional)
    test_preload_cache()
    
    # Test synthesis with different languages and categories
    test_cases = [
        # Korean tests
        ("안녕하세요", "ko", "comment"),
        ("변수", "ko", "variable"),
        ("함수", "ko", "keyword"),
        ("문자열", "ko", "literal"),
        ("연산자", "ko", "operator"),
        ("타입", "ko", "type"),
        
        # English tests
        ("Hello world", "en", "comment"),
        ("variable name", "en", "variable"),
        ("function definition", "en", "keyword"),
        ("string literal", "en", "literal"),
        ("plus operator", "en", "operator"),
        ("integer type", "en", "type"),
        
        # Auto-detection tests
        ("자동 감지 테스트", "auto", "comment"),
        ("automatic detection test", "auto", "comment"),
    ]
    
    print(f"\n🧪 Running {len(test_cases)} synthesis tests...")
    
    success_count = 0
    for i, (text, language, category) in enumerate(test_cases, 1):
        print(f"\n--- Test {i}/{len(test_cases)} ---")
        if test_synthesis(text, language, category):
            success_count += 1
    
    # Test different endpoints for comparison
    print(f"\n🔄 Testing different endpoints for comparison...")
    test_text = "성능 비교 테스트"
    
    # Test fast endpoint (precomputed embeddings)
    test_synthesis(test_text, "ko", "comment", "tts_fast")
    
    # Test regular endpoint
    test_synthesis(test_text, "ko", "comment", "tts")
    
    # Test direct endpoint
    test_synthesis(test_text, "ko", "comment", "tts_direct")
    
    print(f"\n📊 Test Results:")
    print(f"   Successful tests: {success_count}/{len(test_cases)}")
    print(f"   Success rate: {success_count/len(test_cases)*100:.1f}%")
    print(f"   Output directory: {OUTPUT_DIR.absolute()}")
    
    if success_count == len(test_cases):
        print("🎉 All tests passed! Precomputed embeddings are working correctly.")
    else:
        print("⚠️  Some tests failed. Check the logs above for details.")

if __name__ == "__main__":
    main()
