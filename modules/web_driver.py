from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import time

class BrowserAutomation:
    def __init__(self):
        self.driver = None
        print("🌐 Browser automation ready!")

    def start_browser(self):
        options = webdriver.ChromeOptions()
        service = Service(ChromeDriverManager().install())
        self.driver = webdriver.Chrome(service=service, options=options)
        return "Browser started!"
    
    def open_website(self, url):
        if not self.driver:
            self.start_browser()
        self.driver.get(url)
        return f"Opened: {url}"
    
    def close_browser(self):
        if self.driver:
            self.driver.quit()
            self.driver = None
            return "Browser closed!"
        return "No browser to close."

        