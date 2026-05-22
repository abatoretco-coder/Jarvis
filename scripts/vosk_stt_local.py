"""
Local French STT — faster-whisper backend.

Model recommendation (accuracy vs speed on CPU):
  - large-v3-turbo  : best accuracy, moderate speed (~0.8B, int8 quantised)
  - medium          : good balance                  (~244M int8)
  - small           : fastest, decent French        (~74M int8)

Default here: large-v3-turbo.
Models are downloaded automatically on first run to ~/faster-whisper-models/
"""
import argparse

from faster_whisper import WhisperModel


def transcribe_wav(model_name: str, wav_path: str, language: str = "fr") -> str:
    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",          # int8 quantisation — fastest on CPU
        download_root=None,           # default cache (~/.cache/huggingface/hub)
    )
    segments, info = model.transcribe(
        wav_path,
        language=language,
        beam_size=5,
        vad_filter=True,              # skip silence automatically
        vad_parameters={"min_silence_duration_ms": 300},
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    print(f"[lang={info.language} prob={info.language_probability:.2f}] {text}")
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description="Local French STT with faster-whisper")
    parser.add_argument("--wav", required=True, help="Path to audio file (wav/mp3/ogg/…)")
    parser.add_argument("--model", default="large-v3-turbo",
                        choices=["tiny", "base", "small", "medium", "large-v2", "large-v3", "large-v3-turbo"],
                        help="Whisper model size (default: large-v3-turbo)")
    parser.add_argument("--language", default="fr", help="Language code (default: fr)")
    args = parser.parse_args()

    transcribe_wav(args.model, args.wav, args.language)


if __name__ == "__main__":
    main()

