import json
import os

CONFIG_FILE = "config.json"

def update_voice_config(accent):
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)
    else:
        config = {}
    config.setdefault("voice_settings", {})["default_accent"] = accent
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=4)
    print(f"Updated default voice accent to {accent} in {CONFIG_FILE}")

if __name__ == "__main__":
    accent = input("Enter preferred accent (US, British, Indian): ")
    update_voice_config(accent)
