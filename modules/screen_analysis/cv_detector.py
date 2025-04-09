import cv2
import numpy as np
from PIL import ImageGrab

def capture_screen_cv():
    pil_img = ImageGrab.grab()
    cv_img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    return cv_img

def match_template(template_path, threshold=0.8):
    screen = capture_screen_cv()
    template = cv2.imread(template_path, cv2.IMREAD_COLOR)
    if template is None:
        print("Error: Template image not found.")
        return None
    res = cv2.matchTemplate(screen, template, cv2.TM_CCOEFF_NORMED)
    loc = np.where(res >= threshold)
    if len(loc[0]) > 0:
        pt = (int(loc[1][0]), int(loc[0][0]))
        return pt
    else:
        return None

if __name__ == "__main__":
    template_path = "templates/send_button.png"
    match = match_template(template_path)
    if match:
        print("Template found at:", match)
    else:
        print("Template not found.")
