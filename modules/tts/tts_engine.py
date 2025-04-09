import pyttsx3
import json
import os

class TTSEngine:
    def __init__(self, config_file="config.json"):
        self.engine = pyttsx3.init()
        self.voices = self.engine.getProperty('voices')
        self.config_file = config_file
        self.load_config()

    def load_config(self):
        if os.path.exists(self.config_file):
            with open(self.config_file, "r") as f:
                config = json.load(f)
                self.default_accent = config.get("voice_settings", {}).get("default_accent", "US")
        else:
            self.default_accent = "US"

    def set_voice(self, accent):
        selected_voice = None
        for voice in self.voices:
            if accent.lower() in voice.name.lower():
                selected_voice = voice.id
                break
        if selected_voice:
            self.engine.setProperty('voice', selected_voice)
            print(f"TTS voice set to {accent}.")
        else:
            print(f"No voice found for accent {accent}. Using default voice.")

    def speak(self, text):
        self.engine.say(text)
        self.engine.runAndWait()

if __name__ == "__main__":
    tts = TTSEngine(config_file="config.json")
    for accent in ["US", "British", "Indian"]:
        tts.set_voice(accent)
        tts.speak(f"This is a test of the {accent} accent.")
