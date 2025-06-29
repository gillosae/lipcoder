#!/usr/bin/env python3
import argparse

import soundfile as sf
import torch


def main():
    parser = argparse.ArgumentParser(
        description="Run Silero-TTS inference via Torch Hub and write a WAV file."
    )
    parser.add_argument(
        "--language",
        type=str,
        required=True,
        help="Language code (e.g. 'en', 'ru', 'de').",
    )
    parser.add_argument(
        "--model_id",
        type=str,
        required=True,
        help=(
            "Silero model identifier (e.g. 'v3_en', 'v4_ru', 'v3_de'). "
            "Check Silero’s repo for available models."
        ),
    )
    parser.add_argument(
        "--speaker",
        type=str,
        default=None,
        help=(
            "If the chosen model is multi-speaker (e.g. v3_en), pass a pseudo-speaker name "
            "from `model.speakers`. For single-speaker v4 models, omit this."
        ),
    )
    parser.add_argument(
        "--text",
        type=str,
        required=True,
        help='The UTF-8 text to synthesize, e.g. "Hello, world!"',
    )
    parser.add_argument(
        "--output",
        type=str,
        required=True,
        help="Path to write the output WAV file (e.g. ./out.wav)",
    )
    parser.add_argument(
        "--sample_rate",
        type=int,
        default=8000,
        help="Desired output sample rate: 8000, 24000, or 48000 (default=12000).",
    )
    parser.add_argument(
        "--device",
        type=str,
        default="cpu",
        help="Torch device to run on (e.g. 'cpu' or 'cuda').",
    )
    args = parser.parse_args()

    # 1) Determine device
    if args.device.startswith("cuda") and torch.cuda.is_available():
        device = torch.device(args.device)
    else:
        device = torch.device("cpu")
    torch.set_num_threads(4)

    # 2) Load Silero TTS from Torch Hub
    print(f"[silero_tts_infer] Loading Silero {args.model_id} on {device}…")
    hub_return = torch.hub.load(
        repo_or_dir="snakers4/silero-models",
        model="silero_tts",
        language=args.language,
        speaker=args.model_id,
        device=str(device),
        jit=False,  # get the Python version (not TorchScript)
    )

    if not (isinstance(hub_return, tuple) and len(hub_return) >= 2):
        raise RuntimeError(
            f"Unexpected return from torch.hub.load for '{args.model_id}': {hub_return!r}\n"
            "Expected at least two items: (model, example_text)."
        )

    silero_model, _ = hub_return[0], hub_return[1]

    # 3) If multi-speaker model, pick or validate `--speaker`
    all_speakers = getattr(silero_model, "speakers", None)
    if all_speakers:
        print(f"  • Available pseudo-speakers: {all_speakers}")
        if args.speaker is None:
            chosen_speaker = all_speakers[0]
            print(f"  • No --speaker passed; defaulting to '{chosen_speaker}'")
        elif args.speaker not in all_speakers:
            raise ValueError(
                f"Speaker '{args.speaker}' not in {all_speakers}. "
                "Use one of the exact names listed above."
            )
        else:
            chosen_speaker = args.speaker
    else:
        chosen_speaker = args.speaker  # likely None for single‐speaker models

    silero_model.to(device)
    # silero_model.eval()

    # 4) Synthesize
    print(
        f'[silero_tts_infer] Synthesizing ▶ "{args.text}" '
        f"(model={args.model_id}, speaker={chosen_speaker}, sr={args.sample_rate})"
    )
    with torch.no_grad():
        waveform: torch.Tensor = silero_model.apply_tts(
            text=args.text,
            speaker=chosen_speaker,
            sample_rate=args.sample_rate,
        )

    # 5) Save as WAV
    sf.write(args.output, waveform.cpu().numpy(), args.sample_rate)
    print(f"[silero_tts_infer] ✔ Saved synthesized audio to: {args.output}")


if __name__ == "__main__":
    main()
