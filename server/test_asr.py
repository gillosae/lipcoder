#!/usr/bin/env python3
import torch
import numpy as np
import os

# Load the Silero model
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
model, decoder, utils = torch.hub.load(
    repo_or_dir='snakers4/silero-models',
    model='silero_stt',
    language='en',
    device=device
)
read_batch, split_into_batches, read_audio, prepare_model_input = utils

# Test with the audio file
audio_path = "/Users/gillosae/Desktop/lipcoder/client/src/python/hello_v3.wav"

print(f"Testing with audio file: {audio_path}")
print(f"File exists: {os.path.exists(audio_path)}")

# Read audio
wav = read_audio(audio_path, target_sr=16000)
print(f"Wav type: {type(wav)}")
print(f"Wav shape: {wav.shape if hasattr(wav, 'shape') else 'no shape'}")

# Convert to tensor
if isinstance(wav, np.ndarray):
    wav = torch.from_numpy(wav).flatten().float()
elif isinstance(wav, list):
    wav = torch.tensor(wav, dtype=torch.float32).flatten()
elif not torch.is_tensor(wav):
    raise TypeError(f'Unexpected wav type: {type(wav)}')

print(f"After conversion - Wav type: {type(wav)}")
print(f"Wav shape: {wav.shape}")

# Create batches
batches = split_into_batches([wav], batch_size=1)
print(f"Batches type: {type(batches)}")
print(f"Batches length: {len(batches)}")
print(f"First batch type: {type(batches[0])}")

# Prepare model input
input_data = prepare_model_input(batches, device=device)
print(f"Input data type: {type(input_data)}")
print(f"Input data shape: {input_data.shape}")

# Run inference
output = model(input_data)
result = decoder(output[0].cpu())
print(f"Result: {result}") 