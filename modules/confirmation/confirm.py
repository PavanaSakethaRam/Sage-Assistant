import threading
import queue
from modules.tts.tts_engine import TTSEngine
from modules.sst.sst_engine import STTEngine

def confirm_action(prompt_text="Do you want to proceed?", timeout=10):
    tts = TTSEngine()
    stt = STTEngine(model_name="small")
    response_queue = queue.Queue()

    def get_response():
        print("Listening for confirmation response...")
        resp = stt.record_and_transcribe(record_seconds=3)
        response_queue.put(resp)

    tts.speak(prompt_text)
    thread = threading.Thread(target=get_response)
    thread.start()
    thread.join(timeout=timeout)

    if not response_queue.empty():
        response = response_queue.get().strip().lower()
        if "yes" in response:
            tts.speak("Confirmed.")
            return True
        else:
            tts.speak("Action cancelled.")
            return False
    else:
        print("No voice response detected. Please type 'yes' or 'no':")
        answer = input().strip().lower()
        if answer == "yes":
            tts.speak("Confirmed.")
            return True
        else:
            tts.speak("Action cancelled.")
            return False

if __name__ == "__main__":
    result = confirm_action("Are you sure you want to delete the file?")
    print("Confirmation result:", result)
