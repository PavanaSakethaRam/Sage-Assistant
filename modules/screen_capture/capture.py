from PIL import ImageGrab

def capture_full_desktop(save_path=None):
    image = ImageGrab.grab()
    if save_path:
        image.save(save_path)
        print(f"Screenshot saved to {save_path}")
    return image

if __name__ == "__main__":
    img = capture_full_desktop("full_desktop.png")
    img.show()
