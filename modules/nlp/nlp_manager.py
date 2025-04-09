import spacy
import json
import os

nlp = spacy.load("en_core_web_sm")

TRAINING_DATA_FILE = os.path.join(os.path.dirname(__file__), "training_data.json")

class NLPManager:
    def __init__(self):
        if os.path.exists(TRAINING_DATA_FILE):
            with open(TRAINING_DATA_FILE, "r") as f:
                self.training_data = json.load(f)
        else:
            self.training_data = []
        print("NLP Manager initialized.")

    def parse_command(self, text):
        doc = nlp(text.lower())
        intent = {}
        if "open" in text:
            intent["action"] = "open_app"
            for token in doc:
                if token.text in ["browser", "chrome", "edge", "opera", "notepad", "whatsapp", "vscode", "settings", "explorer"]:
                    intent["app"] = token.text
                    break
        elif "send" in text:
            intent["action"] = "send_message"
            intent["details"] = text
        elif "summarize" in text or "summary" in text:
            intent["action"] = "summarize"
            intent["details"] = text
        elif "translate" in text:
            intent["action"] = "translate"
            intent["details"] = text
        elif "click" in text:
            intent["action"] = "click"
            intent["details"] = text
        elif "scroll" in text:
            intent["action"] = "scroll"
            intent["details"] = text
        else:
            intent["action"] = "unknown"
            intent["details"] = text
        return intent

if __name__ == "__main__":
    nlp_manager = NLPManager()
    while True:
        command = input("Enter command: ")
        result = nlp_manager.parse_command(command)
        print("Parsed Result:", result)
