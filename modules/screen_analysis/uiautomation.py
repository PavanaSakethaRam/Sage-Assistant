from pywinauto import Desktop
from pywinauto.findwindows import find_windows

def get_active_window_text():
    try:
        active_handles = find_windows(active_only=True)
        if not active_handles:
            return "No active window found."
        active_handle = active_handles[0]
        active_window = Desktop(backend="uia").window(handle=active_handle)
        return active_window.window_text()
    except Exception as e:
        return f"Error fetching active window text: {e}"

if __name__ == "__main__":
    text = get_active_window_text()
    print("Active Window Text:", text)
