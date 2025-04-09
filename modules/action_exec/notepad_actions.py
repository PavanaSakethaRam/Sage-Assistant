from pywinauto import Application
import time
import os

def open_notepad():
    try:
        app = Application(backend="uia").start("notepad")
        time.sleep(2)
        return app
    except Exception as e:
        print("Error opening Notepad:", e)
        return None

def type_in_notepad(text):
    try:
        app = Application(backend="uia").connect(title_re=".*Notepad")
        window = app.top_window()
        edit = window.set_focus()
        edit.type_keys(text, with_spaces=True)
        print("Text typed in Notepad.")
    except Exception as e:
        print("Error typing in Notepad:", e)

def save_notepad_file(filename):
    try:
        app = Application(backend="uia").connect(title_re=".*Notepad")
        window = app.top_window()
        window.menu_select("File->Save As")
        time.sleep(2)
        save_dlg = app.window(title_re="Save As")
        # filename_box = save_dlg.child_window(auto_id="1001", control_type="Edit")
        # filename_box.set_edit_text(filename)
        time.sleep(1)
        save_dlg.child_window(title="Save", control_type="Button").click_input()
        print("Notepad file saved as", filename)
    except Exception as e:
        print("Error saving file in Notepad:", e)

def summarize_notepad_content():
    try:
        app = Application(backend="uia").connect(title_re=".*Notepad")
        window = app.top_window()
        edit = window.child_window(class_name="Edit")
        content = edit.get_value()
        summary = content[:100] + "..." if len(content) > 100 else content
        print("Summary of Notepad content:", summary)
        return summary
    except Exception as e:
        print("Error summarizing Notepad content:", e)
        return ""

def delete_notepad_file(filepath):
    try:
        os.remove(filepath)
        print(f"File {filepath} deleted.")
    except Exception as e:
        print("Error deleting file:", e)

if __name__ == "__main__":
    app = open_notepad()
    if app:
        type_in_notepad("This is a test note in Notepad. Let's add more text to test summarization.")
        time.sleep(2)
        save_notepad_file("test_note.txt")
        summarize_notepad_content()
