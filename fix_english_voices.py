#!/usr/bin/env python3
"""
Fix English voice quality by creating proper English reference voices
"""

import requests
import os
from pathlib import Path

def create_english_voice_references():
    """Create proper English voice reference files using OpenAI TTS"""
    
    voices_dir = Path("server/voices")
    voices_dir.mkdir(exist_ok=True)
    
    # Different English voice samples for different code categories
    voice_samples = {
        'variable': {
            'text': 'This is a clear English voice for reading variable names and identifiers in your code.',
            'voice': 'alloy'  # Clear, neutral voice
        },
        'keyword': {
            'text': 'This voice will speak programming keywords like function, class, and return statements.',
            'voice': 'echo'  # Slightly different for distinction
        },
        'comment': {
            'text': 'Comments and documentation will be read in this softer, more conversational English voice.',
            'voice': 'nova'  # Softer voice for comments
        },
        'literal': {
            'text': 'String literals and text values will use this clear, articulate English pronunciation.',
            'voice': 'fable'  # Good for reading text
        },
        'operator': {
            'text': 'Mathematical operators and symbols will be spoken with this precise English voice.',
            'voice': 'onyx'  # Strong, clear voice
        },
        'type': {
            'text': 'Type names and class definitions will use this professional English pronunciation.',
            'voice': 'shimmer'  # Professional tone
        },
        'narration': {
            'text': 'General narration and default speech will use this natural, flowing English voice.',
            'voice': 'alloy'  # Default natural voice
        }
    }
    
    print("🎤 Creating English voice reference files...")
    print("=" * 60)
    
    # You'll need to add your OpenAI API key here
    api_key = input("Enter your OpenAI API key (or press Enter to skip): ").strip()
    
    if not api_key:
        print("\n⚠️  No API key provided. Creating sample files with placeholder text.")
        print("   You'll need to replace these with actual English voice samples.")
        
        for category, config in voice_samples.items():
            wav_file = voices_dir / f"{category}.wav"
            print(f"📝 Creating placeholder for {category}: {wav_file}")
            
            # Create a simple text file with instructions
            instructions_file = voices_dir / f"{category}_instructions.txt"
            with open(instructions_file, 'w') as f:
                f.write(f"Voice Reference Instructions for {category.upper()}\n")
                f.write("=" * 50 + "\n\n")
                f.write(f"Sample text: {config['text']}\n\n")
                f.write("To create this voice reference:\n")
                f.write("1. Record yourself or a native English speaker saying the sample text\n")
                f.write("2. Save as a clear, high-quality WAV file (16-24kHz, mono or stereo)\n")
                f.write("3. Keep the recording 3-10 seconds long\n")
                f.write("4. Ensure clear pronunciation and minimal background noise\n")
                f.write(f"5. Save as: {wav_file}\n")
        
        print(f"\n📋 Created instruction files in {voices_dir}/")
        print("   Record English voice samples following the instructions.")
        return False
    
    # Create voice samples using OpenAI TTS
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json'
    }
    
    success_count = 0
    
    for category, config in voice_samples.items():
        wav_file = voices_dir / f"{category}.wav"
        
        print(f"🎵 Creating {category} voice: {config['voice']}")
        
        try:
            response = requests.post(
                'https://api.openai.com/v1/audio/speech',
                headers=headers,
                json={
                    'model': 'tts-1',
                    'voice': config['voice'],
                    'input': config['text'],
                    'response_format': 'wav'
                },
                timeout=30
            )
            
            if response.status_code == 200:
                with open(wav_file, 'wb') as f:
                    f.write(response.content)
                print(f"   ✅ Created: {wav_file}")
                success_count += 1
            else:
                print(f"   ❌ Failed: {response.status_code} - {response.text}")
                
        except Exception as e:
            print(f"   ❌ Error: {e}")
    
    print(f"\n🎉 Successfully created {success_count}/{len(voice_samples)} voice files")
    return success_count > 0

def test_voice_quality():
    """Test the voice quality with XTTS server"""
    
    print("\n🧪 Testing voice quality with XTTS server...")
    
    test_cases = [
        {"text": "hello world", "category": "variable"},
        {"text": "function", "category": "keyword"},
        {"text": "This is a comment", "category": "comment"},
        {"text": "string literal", "category": "literal"},
    ]
    
    server_url = "http://localhost:5006"
    
    # Check if server is running
    try:
        health_response = requests.get(f"{server_url}/health", timeout=5)
        if health_response.status_code != 200:
            print("❌ XTTS server is not running")
            return
    except:
        print("❌ Cannot connect to XTTS server")
        print("   Start the server with: cd server && python xtts_v2_server.py")
        return
    
    print("✅ XTTS server is running")
    
    # Clear cache to force using new voice files
    try:
        requests.post(f"{server_url}/cache/clear", timeout=10)
        print("🗑️  Cleared voice cache")
    except:
        print("⚠️  Could not clear cache")
    
    # Test each voice
    for i, test in enumerate(test_cases, 1):
        print(f"\n{i}. Testing: '{test['text']}' (category: {test['category']})")
        
        try:
            response = requests.post(f"{server_url}/tts_fast", 
                json={
                    "text": test['text'],
                    "language": "en",  # Force English
                    "category": test['category'],
                    "sample_rate": 24000
                },
                timeout=15
            )
            
            if response.status_code == 200:
                print(f"   ✅ SUCCESS - Audio generated ({len(response.content)} bytes)")
            else:
                print(f"   ❌ FAILED - {response.status_code}")
                try:
                    error = response.json()
                    print(f"      Error: {error.get('error', 'Unknown')}")
                except:
                    pass
                    
        except Exception as e:
            print(f"   ❌ ERROR - {e}")

def main():
    print("🔧 XTTS English Voice Quality Fixer")
    print("=" * 60)
    print()
    print("This script will help fix the 'gibberish English' issue by:")
    print("1. Creating proper English voice reference files")
    print("2. Testing the voice quality with your XTTS server")
    print()
    
    # Create voice references
    if create_english_voice_references():
        print("\n🔄 Restarting XTTS server is recommended to load new voices")
        input("Press Enter after restarting the server to test voice quality...")
        test_voice_quality()
    else:
        print("\n📝 Manual voice creation required - follow the instruction files")
    
    print("\n" + "=" * 60)
    print("💡 Additional Tips:")
    print("1. Restart the XTTS server after adding new voice files")
    print("2. Check server logs for '[DEBUG]' messages about language detection")
    print("3. Clear the TTS cache if voices still sound wrong")
    print("4. Ensure voice files are clear English speakers (3-10 seconds)")

if __name__ == "__main__":
    main()
