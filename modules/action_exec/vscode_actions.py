from pywinauto import Application
import time

def open_vscode():
    try:
        app = Application(backend="uia").start("code.cmd", wait_for_idle=False)
        time.sleep(3)
        return app
    except Exception as e:
        print("Error opening VS Code:", e)
        return None

def search_file_in_vscode(filename):
    try:
        app = Application(backend="uia").connect(title_re=".*Visual Studio Code.*",found_index=0)
        window = app.top_window()
        window.type_keys("^p")
        time.sleep(1)
        window.type_keys(filename)
        time.sleep(2)
        window.type_keys("{ENTER}")
        print(f"File {filename} opened in VS Code.")
    except Exception as e:
        print("Error searching file in VS Code:", e)

if __name__ == "__main__":
    app = open_vscode()
    if app:
        search_file_in_vscode("example.py")
        time.sleep(5)
