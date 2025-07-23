#!/usr/bin/env python3
import argparse
import requests
import sys

def main():
    parser = argparse.ArgumentParser(
        description="Send a WAV file to the Silero ASR server and print the transcription."
    )
    parser.add_argument(
        "audio", help="Path to the WAV audio file to transcribe (must be 16 kHz WAV)."
    )
    parser.add_argument(
        "--host", default="localhost", help="ASR server host (default: localhost)"
    )
    parser.add_argument(
        "--port", type=int, default=5003, help="ASR server port (default: 5003)"
    )
    args = parser.parse_args()

    url = f"http://{args.host}:{args.port}/asr"
    try:
        with open(args.audio, "rb") as f:
            files = {"audio": (args.audio, f, "audio/wav")}
            resp = requests.post(url, files=files)
    except FileNotFoundError:
        print(f"Error: cannot open file {args.audio}", file=sys.stderr)
        sys.exit(1)

    if resp.ok:
        data = resp.json()
        print("Transcription:")
        print(data.get("text", "<no text>"))
    else:
        print(f"Server returned {resp.status_code}:", resp.text, file=sys.stderr)
        sys.exit(2)

if __name__ == "__main__":
    main() 