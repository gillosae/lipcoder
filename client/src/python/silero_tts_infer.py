import argparse

import soundfile as sf
import torch


def load_local_model(model_path: str, device):
    """
    Given a path to a TorchScript TTS model that already includes the vocoder,
    load it on `device`. Assumes the model is saved with TorchScript.
    """
    model = torch.jit.load(model_path, map_location=device)
    model.eval()
    return model


def main():
    parser = argparse.ArgumentParser(
        description="Run Silero-TTS inference from a local TorchScript checkpoint (v3+)."
    )
    parser.add_argument(
        "--model_path",
        required=True,
        help="Path to the TorchScript TTS model that includes vocoder (e.g. v3_en.pt)",
    )
    parser.add_argument(
        "--speaker_id",
        type=int,
        default=0,
        help="Integer speaker index (e.g. 0..N−1 for multi-speaker v3). Use model.available_speakers() to inspect.",
    )
    parser.add_argument(
        "--text",
        required=True,
        help='The text string to synthesize, e.g. "Hello, world!"',
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Where to write the output WAV file (e.g. ./out.wav)",
    )
    parser.add_argument(
        "--sample_rate",
        type=int,
        default=24000,
        help="Sample rate to synthesize at (v3 supports 8000/24000/48000; default=24000).",
    )
    args = parser.parse_args()

    # 1) Set device to CPU and limit threads
    device = torch.device("cpu")
    torch.set_num_threads(4)

    # 2) Load the Silero TTS model (which already contains the vocoder)
    model = load_local_model(args.model_path, device)

    # 3) Synthesize: model.apply_tts returns a 1-D FloatTensor of waveform samples
    waveform_tensor = model.apply_tts(
        text=args.text, speaker=args.speaker_id, sample_rate=args.sample_rate
    )

    # 4) Save as WAV
    sf.write(args.output, waveform_tensor.cpu().numpy(), args.sample_rate)
    print(f"Saved synthesized audio to: {args.output}")


if __name__ == "__main__":
    main()
