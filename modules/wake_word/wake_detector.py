import pvporcupine
import pyaudio
import struct
import threading
import time

class WakeWordDetector:
    def __init__(self, callback=None):
        self.callback = callback
        self._running = False
        self.porcupine = pvporcupine.create(keywords=["computer"], sensitivities=[1])
        self.audio = pyaudio.PyAudio()
        self.stream = self.audio.open(
            rate=self.porcupine.sample_rate,
            channels=1,
            format=pyaudio.paInt16,
            input=True,
            frames_per_buffer=self.porcupine.frame_length,
            input_device_index=None
        )

    def start(self):
        self._running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        print("WakeWordDetector started. Listening for wake word...")

    def _run(self):
        while self._running:
            pcm = self.stream.read(self.porcupine.frame_length, exception_on_overflow=False)
            pcm_unpacked = struct.unpack_from("h" * self.porcupine.frame_length, pcm)
            result = self.porcupine.process(pcm_unpacked)
            if result >= 0:
                print("Wake word detected!")
                if self.callback:
                    self.callback()
                time.sleep(1)

    def stop(self):
        self._running = False
        self.thread.join()
        self.stream.stop_stream()
        self.stream.close()
        self.audio.terminate()
        self.porcupine.delete()
        print("WakeWordDetector stopped.")

if __name__ == "__main__":
    def test_callback():
        print("Callback triggered: Wake word detected!")
    detector = WakeWordDetector(callback=test_callback)
    try:
        detector.start()
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        detector.stop()
