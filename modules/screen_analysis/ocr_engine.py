import pytesseract
from PIL import ImageGrab

def capture_screen():
    image = ImageGrab.grab()
    return image

def ocr_image(image):
    gray = image.convert("L")
    text = pytesseract.image_to_string(gray)
    return text

def capture_and_ocr():
    image = capture_screen()
    return ocr_image(image)

if __name__ == "__main__":
    img = capture_screen()
    img.show()
    extracted_text = ocr_image(img)
    print("OCR Extracted Text:")
    print(extracted_text)
