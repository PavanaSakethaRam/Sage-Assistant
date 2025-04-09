# Sage Assistant 🤖

SageAssistant is an AI-powered desktop assistant for Windows that enables real-time voice interaction and screen automation. Inspired by futuristic assistants like JARVIS and EDITH, SageAssistant lets you control browsers, VS Code, WhatsApp, Notepad, system settings, and more—all through natural voice commands. Simply say "Hey Sage" and let the magic begin! 🎤✨

## Features 🌟

- **Wake Word Detection 🔊**  
    Continuously listens for "Hey Sage" using an offline wake word detector running in a separate thread, with adjustable sensitivity.

- **Speech-to-Text (STT) 🗣️➡️💬**  
    Utilizes OpenAI Whisper (small model) for fast (<500ms delay) real-time transcription of your voice commands.

- **Natural Language Processing & Dialogue Management 💡**  
    Powered by a custom NLP module based on spaCy to interpret commands and maintain conversation context, backed by a training set of 100-150 common phrases.

- **Screen Understanding 🖥️🔍**  
    Combines Windows UI Automation (pywinauto), Tesseract OCR, and OpenCV for capturing screen content and extracting both text and visuals.

- **Browser Automation (Selenium) 🌐**  
    Controls Chrome, Edge, and Opera to automate tasks like sending LinkedIn messages, filling out forms, and managing media playback.

- **VS Code Automation (pywinauto) 📝**  
    Launches VS Code, searches files, edits code, and manages extensions seamlessly.

- **WhatsApp Automation (pywinauto) 💬**  
    Opens the WhatsApp Microsoft Store App, searches contacts, sends messages, and even manages audio/video calls.

- **Notepad Automation (pywinauto) 🗒️**  
    Facilitates voice typing, file management, text summarization, and language translation (e.g., Japanese, Korean, Chinese to English).

- **System Actions ⚙️**  
    Offers control over 15-20 system settings including Windows Settings, File Explorer, connectivity (WiFi, Bluetooth, airplane mode), plus volume and brightness adjustments.

- **Text-to-Speech (TTS) 🔈**  
    Delivers natural-sounding voice responses using open-source TTS engines (like Mimic 3 or Coqui TTS) with US, British, or Indian accents.

- **Confirmation & Safety Module ✅**  
    Prompts for voice confirmation for critical actions, with a 10-second timeout fallback to a CLI prompt. Settings are configurable via JSON.

- **User Authentication (Voice Profile Detection) 🛡️🎤**  
    Enrolls user voice profiles for security during sensitive operations, with an option for admin override.

- **Custom Commands 🛠️**  
    Allows adding user-defined commands via a CLI prompt or manual JSON modifications. Custom commands can override built-in actions.

- **On-Demand Screen Capture 📸**  
    Captures your desktop upon voice command, with real-time translation of on-screen non-English text (like Manga dialogues).

- **Logging & Error Handling 📝❗**  
    Offers detailed logging (default INFO with DEBUG available) and descriptive error messages. Certain debug functions are protected by a password.

## Requirements 💻

- Windows 11 Home (Latest)  
- Python 3.10.10, pip 25.0.1  
- Tesseract OCR (installed & added to PATH)  
- ChromeDriver, EdgeDriver, OperaDriver (configured in PATH)  
- Intel Core i5 (11th Gen) or AMD Ryzen 5 (5000 series) CPU (Recommended)  
- 16GB RAM (Recommended)  
- NVIDIA GPU (optional for CUDA acceleration)  
- CUDA Toolkit and cuDNN (if GPU acceleration needed)

## Installation 🚀

1. Clone the repository:
     ```
     git clone https://github.com/PavanaSakethaRam/SageAssistant.git
     cd SageAssistant
     ```

2. Create and activate a virtual environment:
     ```
     python -m venv venv
     venv\Scripts\activate
     ```

3. Install the required packages:
     ```
     pip install -r requirements.txt
     ```

4. Download the spaCy English model:
     ```
     python -m spacy download en_core_web_sm
     ```

5. Install Tesseract OCR and ensure its installation directory is added to your system PATH.

6. Download and configure the necessary web drivers for Selenium (ChromeDriver, EdgeDriver, OperaDriver).

## Configuration ⚙️

Edit the `config.json` file to set:
- Default TTS voice accent (US, British, Indian)
- Critical action settings
- Custom command mappings
- User authentication preferences

## Usage 🎙️

1. Run the assistant:
     ```
     python main.py
     ```
2. SageAssistant listens in the background for the wake word "Hey Sage".
3. Once activated, it prompts you for your command using voice input.
4. Commands are processed using NLP and appropriate actions are executed:
     - Opening apps (Notepad, VS Code, WhatsApp, etc.)
     - Executing browser tasks with Selenium
     - Performing screen capture and translation tasks on demand
5. For sensitive actions, a voice confirmation prompt is issued with a 10-second CLI fallback.
6. Custom commands can be added via the provided CLI prompt or directly in `config.json`.

## Testing 🧪

Test individual modules:
- `python modules/wake_word/wake_detector.py` for wake word detection.
- `python modules/stt/stt_engine.py` for voice transcription.
- `python modules/screen_analysis/ocr_engine.py` for screen capture and OCR.
- `python modules/logger/logger_manager.py` for logging.

After module tests, run `main.py` for an end-to-end assessment of the assistant.

## Future Enhancements 🔮

- Expand NLP capabilities with a more advanced dialogue manager.
- Improve computer vision templates and enhance dynamic UI element detection.
- Integrate control over more system settings related to connectivity and hardware.
- Transition from CLI to a full-featured GUI dashboard.

## License 📄

This project is licensed under the MIT License. Feel free to use, modify, and share the code as per the license terms.

## Contact 📧

For issues or feature requests, please open an issue or contact the project maintainer.
