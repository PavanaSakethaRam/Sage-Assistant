from pywinauto import Application, Desktop, mouse
import time

def open_whatsapp():
    try:
        whatsapp_aumid = "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"
        command = f"explorer.exe shell:AppsFolder\\{whatsapp_aumid}"
        app = Application(backend="uia").start(command, wait_for_idle=False)
        time.sleep(5)
        return app
    except Exception as e:
        print("Error opening WhatsApp:", e)
        return None

def send_message_whatsapp(contact, message):
    try:
        app = Application(backend="uia").connect(title_re=".*WhatsApp.*")
        window = app.top_window()
        # window.set_focus()
        time.sleep(1)
        
        window.type_keys("^f", pause=0.5)
        time.sleep(0.5)
        window.type_keys(contact, with_spaces=True)
        time.sleep(1)
        window.type_keys("{TAB}")
        time.sleep(1)
        window.type_keys("{ENTER}")
        time.sleep(1)
        
        mouse.click(button="right", coords=(100, 100))
        
        window.type_keys(message, with_spaces=True)
        time.sleep(1)
        window.type_keys("{ENTER}")
        print("Message sent on WhatsApp using alternative approach.")
    except Exception as e:
        print("Error sending message on WhatsApp (alternative):", e)

def call_whatsapp(call_type="audio"):
    try:
        app = Application(backend="uia").connect(title_re=".*WhatsApp.*")
        window = app.top_window()
        if call_type == "audio":
            call_button = window.child_window(title="Voice call", control_type="Button", found_index=0)
        elif call_type == "video":
            call_button = window.child_window(title="Video call", control_type="Button", found_index=0)
        else:
            print("Unknown call type.")
            return
        call_button.click_input()
        time.sleep(5)
        end_button = window.child_window(title="End call", control_type="Button")
        end_button.click_input()
        print(f"{call_type.capitalize()} call handled on WhatsApp.")
    except Exception as e:
        print("Error during WhatsApp call automation:", e)

if __name__ == "__main__":
    app = open_whatsapp()
    if app:
        send_message_whatsapp("Snigy", "Hello, this is a test message.")
        time.sleep(5)
        # call_whatsapp(call_type="audio")
