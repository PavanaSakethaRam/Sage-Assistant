import json
import os

CONFIG_FILE = "config.json"

def load_custom_commands():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)
        return config.get("custom_commands", {})
    return {}

def save_custom_commands(commands):
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)
    else:
        config = {}
    config["custom_commands"] = commands
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=4)
    print("Custom commands updated.")

def add_custom_command(command_key, action, override=False):
    commands = load_custom_commands()
    if override or command_key not in commands:
        commands[command_key] = action
        save_custom_commands(commands)
    else:
        print(f"Command '{command_key}' already exists. Use override=True to replace.")

def cli_add_command():
    command_key = input("Enter the custom command keyword: ")
    action = input("Enter the action (e.g., open youtube.com): ")
    override_input = input("Override if exists? (yes/no): ").strip().lower()
    override = True if override_input == "yes" else False
    add_custom_command(command_key, action, override)
    print("Command added.")

if __name__ == "__main__":
    while True:
        cli_add_command()
        cont = input("Add another command? (yes/no): ").strip().lower()
        if cont != "yes":
            break
