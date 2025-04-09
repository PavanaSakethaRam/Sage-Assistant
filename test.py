# import pytesseract
# from PIL import Image

# # Optional: Specify the tesseract executable path if it's not in your PATH
# pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

# # Check Tesseract version
# print("Tesseract Version:", pytesseract.get_tesseract_version())

# # Open an image file (replace 'test.png' with the path to your image)
# img = Image.open("test.png")

# # Use pytesseract to extract text from the image
# text = pytesseract.image_to_string(img)
# print("Extracted Text:", text)



# # import tweepy

# # apiKey= 'kVTwlCIWpdbPItEOFlZgqbKOq'
# # apiSecret= 'tPwkt2FTBOeoKOUQQ0QuiMnnZvQHZfANabZKqAR06vIq31H88r'
# # accessToken= '1408020571208568833-sk5nWl7rkeeUw8irY0l6Fil8cJS9XY'
# # accessTokenSecret= 'qOg4Fcy3XaKQhvKaHnwNxfn1LxRY3Z9J5n5dmkh6zdeLk'

# # client = tweepy.Client(
# #     consumer_key=apiKey, consumer_secret=apiSecret,
# #     access_token=accessToken, access_token_secret=accessTokenSecret
# # )

# # text = 'Hello, World!'
# # client.create_tweet(text="Hi how are you?")


# from TTS.api import TTS

# # Initialize the model
# tts = TTS("tts_models/en/vctk/fast_pitch")

# # Print available speakers
# print("Available speakers:", tts.speakers)

# # Choose a speaker from the list (e.g., the first one)
# selected_speaker = tts.speakers[10]

# # Synthesize speech using the selected speaker
# tts.tts_to_file(
#     text="Hello, world! This is Coqui TTS on Windows.",
#     speaker=selected_speaker,
#     file_path="output.wav"
# )

# print("Speech synthesis complete! Check 'output.wav'.")

# import torch
# print("CUDA available:", torch.cuda.is_available())
# print("cuDNN enabled:", torch.backends.cudnn.enabled)
# print("CUDA version:", torch.version.cuda)

