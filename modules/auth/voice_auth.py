import os
import json
import numpy as np
from resemblyzer import VoiceEncoder, preprocess_wav
import sounddevice as sd
import time
import tempfile
import wave

def record_sample(duration=3, fs=16000):
    print("Recording sample...")
    recording = sd.rec(int(duration * fs), samplerate=fs, channels=1, dtype='float32')
    sd.wait()
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
    with wave.open(temp_file.name, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(fs)
        wf.writeframes((recording * 32767).astype(np.int16).tobytes())
    return temp_file.name

def enroll_voice(admin_id="admin", num_samples=3):
    encoder = VoiceEncoder()
    embeddings = []
    for i in range(num_samples):
        print(f"Recording sample {i+1} for enrollment...")
        sample_path = record_sample(duration=3)
        wav = preprocess_wav(sample_path)
        embedding = encoder.embed_utterance(wav)
        embeddings.append(embedding)
        os.remove(sample_path)
        time.sleep(1)
    avg_embedding = np.mean(embeddings, axis=0)
    data = {"admin_embedding": avg_embedding.tolist()}
    with open("voice_profile.json", "w") as f:
        json.dump(data, f)
    print("Voice profile enrolled successfully.")

def verify_voice(threshold=0.75):
    if not os.path.exists("voice_profile.json"):
        print("No voice profile found. Please enroll first.")
        return False
    with open("voice_profile.json", "r") as f:
        data = json.load(f)
    stored_embedding = np.array(data["admin_embedding"])
    encoder = VoiceEncoder()
    print("Please say your verification phrase...")
    sample_path = record_sample(duration=3)
    wav = preprocess_wav(sample_path)
    current_embedding = encoder.embed_utterance(wav)
    os.remove(sample_path)
    similarity = np.dot(stored_embedding, current_embedding) / (np.linalg.norm(stored_embedding) * np.linalg.norm(current_embedding))
    print("Similarity score:", similarity)
    if similarity >= threshold:
        print("Voice verified as admin.")
        return True
    else:
        print("Voice verification failed.")
        return False

if __name__ == "__main__":
    choice = input("Type 'enroll' to enroll or 'verify' to verify: ").strip().lower()
    if choice == "enroll":
        enroll_voice()
    elif choice == "verify":
        result = verify_voice()
        print("Verification result:", result)
