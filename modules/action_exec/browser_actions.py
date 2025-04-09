from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
import time

class BrowserActions:
    def __init__(self, browser="chrome"):
        self.browser = browser.lower()
        if self.browser == "chrome":
            self.driver = webdriver.Chrome()
        # elif self.browser == "edge":
        #     self.driver = webdriver.Edge()
        # elif self.browser == "opera":
        #     self.driver = webdriver.Opera()
        else:
            raise ValueError("Unsupported browser specified.")

    def open_url(self, url):
        self.driver.get(url)
        time.sleep(2)

    def search_linkedin_and_message(self, contact_name, company, message):
        self.open_url("https://www.linkedin.com")
        time.sleep(3)
        try:
            search_bar = self.driver.find_element(By.XPATH, "//input[contains(@placeholder, 'Search')]")
            search_bar.clear()
            search_query = f"{contact_name} {company}"
            search_bar.send_keys(search_query)
            search_bar.send_keys(Keys.ENTER)
            time.sleep(3)
            results = self.driver.find_elements(By.XPATH, "//a[contains(@href, '/in/')]")
            if results:
                results[0].click()
                time.sleep(3)
                msg_buttons = self.driver.find_elements(By.XPATH, "//button[contains(text(), 'Message')]")
                if msg_buttons:
                    msg_buttons[0].click()
                    time.sleep(3)
                    text_area = self.driver.find_element(By.XPATH, "//textarea")
                    text_area.send_keys(message)
                    time.sleep(1)
                    text_area.send_keys(Keys.ENTER)
                    print("Message sent on LinkedIn.")
                else:
                    print("Message button not found.")
            else:
                print("No search results found on LinkedIn.")
        except Exception as e:
            print("Error during LinkedIn messaging:", e)

    def close_browser(self):
        self.driver.quit()

if __name__ == "__main__":
    ba = BrowserActions(browser="chrome")
    ba.open_url("https://www.youtube.com")
    time.sleep(5)
    ba.close_browser()
