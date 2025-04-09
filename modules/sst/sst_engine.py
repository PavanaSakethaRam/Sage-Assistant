import whisper
import pyaudio
import wave
import os
import tempfile

class STTEngine:
    def __init__(self, model_name="small"):
        print("Loading Whisper model...")
        self.model = whisper.load_model(model_name)
        print("Whisper model loaded.")
        self.format = pyaudio.paInt16
        self.channels = 1
        self.rate = 24000
        self.chunk = 1024

    def record_audio(self, record_seconds=5):
        print(f"Recording audio for {record_seconds} seconds...")
        p = pyaudio.PyAudio()
        stream = p.open(format=self.format, channels=self.channels, rate=self.rate,
                        input=True, frames_per_buffer=self.chunk)
        frames = []
        for _ in range(0, int(self.rate / self.chunk * record_seconds)):
            data = stream.read(self.chunk)
            frames.append(data)
        stream.stop_stream()
        stream.close()
        p.terminate()

        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        wf = wave.open(temp_file.name, 'wb')
        wf.setnchannels(self.channels)
        wf.setsampwidth(p.get_sample_size(self.format))
        wf.setframerate(self.rate)
        wf.writeframes(b''.join(frames))
        wf.close()
        print(f"Audio recorded to {temp_file.name}")
        return temp_file.name

    def transcribe(self, audio_path):
        print(f"Transcribing audio from {audio_path}...")
        result = self.model.transcribe(audio_path)
        transcription = result["text"].strip()
        print("Transcription:", transcription)
        return transcription

    def record_and_transcribe(self, record_seconds=5):
        audio_path = self.record_audio(record_seconds)
        transcription = self.transcribe(audio_path)
        os.remove(audio_path)
        return transcription

if __name__ == "__main__":
    stt = STTEngine(model_name="small")
    text = stt.record_and_transcribe(record_seconds=5)
    print("Final Transcription:", text)
