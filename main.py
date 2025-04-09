import time
import logging
from modules.logger.logger_manager import setup_logger
from modules.wake_word.wake_detector import WakeWordDetector
from modules.sst.sst_engine import STTEngine
from modules.nlp.nlp_manager import NLPManager
from modules.action_exec import browser_actions, vscode_actions, whatsapp_actions, notepad_actions, system_actions
from modules.tts.tts_engine import TTSEngine
from modules.confirmation.confirm import confirm_action
from modules.auth.voice_auth import verify_voice
from modules.custom_commands.custom_manager import load_custom_commands
from modules.screen_capture.capture import capture_full_desktop

logger = setup_logger(level=logging.INFO)
tts_engine = TTSEngine()
stt_engine = STTEngine(model_name="small")
nlp_manager = NLPManager()

def process_command(command_text):
    logger.info(f"Processing command: {command_text}")
    intent = nlp_manager.parse_command(command_text)
    logger.info(f"Identified intent: {intent}")
    action = intent.get("action")
    
    if action == "open_app":
        app = intent.get("app", "")
        if app in ["notepad"]:
            notepad_actions.open_notepad()
        elif app in ["vscode", "code"]:
            vscode_actions.open_vscode()
        elif app in ["whatsapp"]:
            whatsapp_actions.open_whatsapp()
        elif app in ["settings"]:
            system_actions.open_settings()
        elif app in ["explorer"]:
            system_actions.open_explorer()
        else:
            tts_engine.speak("I did not recognize the application to open.")
    elif action == "send_message":
        details = intent.get("details", "")
        if "linkedin" in details:
            ba = browser_actions.BrowserActions(browser="chrome")
            ba.search_linkedin_and_message("John Doe", "CompanyX", "Hello, this is an automated message.")
            ba.close_browser()
        else:
            tts_engine.speak("Send message functionality for this platform is not implemented yet.")
    elif action == "summarize":
        summary = notepad_actions.summarize_notepad_content()
        tts_engine.speak(f"The summary is: {summary}")
    elif action == "translate":
        from modules.screen_analysis.ocr_engine import ocr_image
        image = capture_full_desktop()
        text = ocr_image(image)
        tts_engine.speak("Translation feature is under development. The captured text begins: " + text[:100])
    elif action in ["click", "scroll"]:
        tts_engine.speak("This action is not implemented yet.")
    else:
        tts_engine.speak("I'm sorry, I did not understand that command.")

def wake_callback():
    tts_engine.speak("Yes, how can I help you?")
    command_text = stt_engine.record_and_transcribe(record_seconds=5)
    tts_engine.speak(f"You said: {command_text}. Processing your request.")
    process_command(command_text)

def main_loop():
    logger.info("Starting main loop. Waiting for wake word...")
    wake_detector = WakeWordDetector(callback=wake_callback)
    wake_detector.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("Shutting down assistant.")
        wake_detector.stop()

if __name__ == "__main__":
    main_loop()
